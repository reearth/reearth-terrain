//! Cesium quantized-mesh-1.0 terrain tile generation
//!
//! Generates binary .terrain files compatible with Cesium's quantized-mesh-1.0 format
//! using the Martini RTIN algorithm for mesh simplification.

use super::martini::Martini;
use super::quantized_mesh::{
    EdgeIndices, EncodeOptions, QUANTIZED_MAX, QuantizedMeshEncoder, QuantizedMeshHeader,
    QuantizedVertices, TileBounds, TileMetadata, WaterMask, coords::geodetic_to_ecef,
};

// Re-export types for use by other modules. `MeshAvailableRange` and
// `MeshTileMetadata` aren't called from the current WASM surface but
// they ride along with the metadata extension; they'll be the obvious
// entry point when we expose tile-availability metadata.
#[allow(unused_imports)]
pub use super::quantized_mesh::{
    AvailableRange as MeshAvailableRange, TileBounds as MeshTileBounds,
    TileMetadata as MeshTileMetadata, WaterMask as MeshWaterMask,
};

/// Grid size for mesh generation (must be 2^n + 1).
/// 65x65 matches Cesium's heightmap format for consistency.
pub const MESH_GRID_SIZE: u32 = 65;

/// Elevations sampled on a grid that extends `halo` cells *beyond* the tile
/// on each side. Used by [`compute_vertex_normals_from_gradient`] so that
/// adjacent tiles read the same DEM samples at any shared physical position
/// and the seam normals match.
///
/// Layout: row-major, north → south, `(MESH_GRID_SIZE + 2*halo)` per side.
#[derive(Debug, Clone)]
pub struct HaloElevations {
    pub elevations: Vec<f64>,
    pub halo: u32,
}

/// Options for generating quantized mesh tiles.
#[derive(Debug, Clone)]
pub struct QuantizedMeshOptions {
    /// Maximum error threshold for mesh simplification (meters).
    /// Lower values produce more detailed meshes with more triangles.
    pub max_error: f64,
    /// Include oct-encoded vertex normals for lighting.
    pub include_normals: bool,
    /// Include water mask extension.
    pub include_water_mask: bool,
    /// Water mask data (if include_water_mask is true).
    pub water_mask: Option<WaterMask>,
    /// Include metadata extension with tile availability.
    pub include_metadata: bool,
    /// Tile X coordinate (used for metadata generation).
    pub tile_x: Option<u32>,
    /// Tile Y coordinate (used for metadata generation).
    pub tile_y: Option<u32>,
    /// Current zoom level of the tile (used for metadata generation).
    pub current_zoom: Option<u8>,
    /// Maximum zoom level (used for metadata generation).
    pub max_zoom: Option<u8>,
    /// Gzip compression level (0-9, default 6).
    pub compression_level: u32,
    /// When `Some`, normals are computed from the DEM gradient using this
    /// halo-extended grid, which keeps lighting continuous across tile
    /// boundaries. When `None`, normals fall back to per-tile face-normal
    /// accumulation, which is visibly discontinuous at tile edges.
    pub halo_elevations: Option<HaloElevations>,
}

impl Default for QuantizedMeshOptions {
    fn default() -> Self {
        Self {
            max_error: 5.0,
            include_normals: false,
            include_water_mask: false,
            water_mask: None,
            include_metadata: false,
            tile_x: None,
            tile_y: None,
            current_zoom: None,
            max_zoom: None,
            compression_level: 6,
            halo_elevations: None,
        }
    }
}

/// A generated quantized mesh terrain tile.
#[derive(Debug)]
pub struct QuantizedMeshTile {
    /// Gzipped binary data ready to serve.
    pub data: Vec<u8>,
    /// Number of vertices in the mesh.
    pub vertex_count: usize,
    /// Number of triangles in the mesh.
    pub triangle_count: usize,
}

/// Generate a quantized mesh terrain tile from elevation data.
///
/// # Arguments
///
/// * `elevations` - Elevation data in 65x65 grid (row-major, north to south).
/// * `bounds` - Geographic bounds of the tile (degrees).
/// * `options` - Mesh generation options.
///
/// # Returns
///
/// A quantized mesh tile ready to serve to Cesium.
pub fn generate_quantized_mesh_tile(
    elevations: &[f64],
    bounds: &TileBounds,
    options: &QuantizedMeshOptions,
) -> QuantizedMeshTile {
    let grid_size = MESH_GRID_SIZE as usize;
    assert!(
        elevations.len() >= grid_size * grid_size,
        "Expected at least {} elevation values, got {}",
        grid_size * grid_size,
        elevations.len()
    );

    // Find min/max heights (excluding NaN)
    let (min_height, max_height) = find_height_range(elevations);

    // Generate mesh using Martini algorithm
    let mut martini = Martini::new(MESH_GRID_SIZE);

    // Create terrain from elevation data
    // Martini expects (x, y) where x is column and y is row
    let tile = martini.create_terrain(|x, y| {
        let idx = y * grid_size + x;
        let h = elevations.get(idx).copied().unwrap_or(0.0);
        if h.is_nan() { 0.0 } else { h }
    });

    // Generate mesh with error threshold
    let (vertices_flat, indices, _uvs) =
        tile.construct_mesh(&mut martini, options.max_error, &mut |(u, v)| {
            // Transform UV to geographic coordinates
            let lon = bounds.west + u * (bounds.east - bounds.west);
            let lat = bounds.south + v * (bounds.north - bounds.south);

            // Sample height at this UV position
            let px = (u * (grid_size - 1) as f64).round() as usize;
            let py = ((1.0 - v) * (grid_size - 1) as f64).round() as usize;
            let idx = py.min(grid_size - 1) * grid_size + px.min(grid_size - 1);
            let height = elevations.get(idx).copied().unwrap_or(0.0);
            let height = if height.is_nan() { 0.0 } else { height };

            (lon, lat, height)
        });

    // Convert to quantized vertices
    let vertex_count = vertices_flat.len() / 3;
    let mut vertices = QuantizedVertices::with_capacity(vertex_count);

    for i in 0..vertex_count {
        let lon = vertices_flat[i * 3] as f64;
        let lat = vertices_flat[i * 3 + 1] as f64;
        let height = vertices_flat[i * 3 + 2] as f64;

        // Quantize coordinates
        let u = quantize_coordinate(lon, bounds.west, bounds.east);
        let v = quantize_coordinate(lat, bounds.south, bounds.north);
        let h = quantize_height(height, min_height, max_height);

        vertices.push(u, v, h);
    }

    // Extract edge indices
    let edge_indices = EdgeIndices::from_vertices(&vertices);

    // Create header — pass the mesh vertices so the horizon-occlusion point
    // is tight enough that Cesium doesn't false-cull tiles near the bounding
    // sphere's "equator" (e.g. anywhere in the eastern hemisphere with a small
    // ECEF Y component, like Geneva or Amsterdam).
    let occlusion_vertices: Vec<(f64, f64, f64)> = (0..vertex_count)
        .map(|i| {
            (
                vertices_flat[i * 3] as f64,
                vertices_flat[i * 3 + 1] as f64,
                vertices_flat[i * 3 + 2] as f64,
            )
        })
        .collect();
    let header = QuantizedMeshHeader::from_bounds_with_vertices(
        bounds,
        min_height as f32,
        max_height as f32,
        &occlusion_vertices,
    );

    // Compute normals if requested. Prefer the DEM-gradient path when a
    // halo grid is available — face-normal accumulation only sees triangles
    // inside the current tile, so the same physical edge is shaded
    // inconsistently from adjacent tiles. Gradient normals computed from a
    // halo-extended DEM grid use the same samples both tiles can see, so
    // edge vertices get identical normals on both sides.
    let normals = if options.include_normals {
        if let Some(halo) = &options.halo_elevations {
            Some(compute_vertex_normals_from_gradient(
                &vertices, bounds, halo,
            ))
        } else {
            Some(compute_vertex_normals(
                &vertices, &indices, bounds, min_height, max_height,
            ))
        }
    } else {
        None
    };

    // Generate metadata if requested
    let metadata = if options.include_metadata {
        let tile_x = options.tile_x.unwrap_or(0);
        let tile_y = options.tile_y.unwrap_or(0);
        let current_zoom = options.current_zoom.unwrap_or(0);
        let max_zoom = options.max_zoom.unwrap_or(15);
        Some(TileMetadata::for_tile(
            tile_x,
            tile_y,
            current_zoom,
            max_zoom,
        ))
    } else {
        None
    };

    // Encode the mesh
    let encoder = QuantizedMeshEncoder::new(header, vertices, indices.clone(), edge_indices);

    let encode_options = EncodeOptions {
        include_normals: options.include_normals,
        normals,
        include_water_mask: options.include_water_mask,
        water_mask: options.water_mask.clone(),
        include_metadata: options.include_metadata,
        metadata,
        compression_level: options.compression_level,
    };

    let data = encoder.encode_with_options(&encode_options);

    QuantizedMeshTile {
        data,
        vertex_count,
        triangle_count: indices.len() / 3,
    }
}

/// Find the height range in elevation data, excluding NaN values.
fn find_height_range(elevations: &[f64]) -> (f64, f64) {
    let mut min_height = f64::MAX;
    let mut max_height = f64::MIN;

    for &h in elevations {
        if !h.is_nan() {
            min_height = min_height.min(h);
            max_height = max_height.max(h);
        }
    }

    // Handle case where all values are NaN
    if min_height > max_height {
        min_height = 0.0;
        max_height = 0.0;
    }

    // Ensure we have some range to avoid division by zero
    if (max_height - min_height).abs() < 1e-6 {
        max_height = min_height + 1.0;
    }

    (min_height, max_height)
}

/// Quantize a coordinate value to 0-32767 range.
#[inline]
fn quantize_coordinate(value: f64, min: f64, max: f64) -> u16 {
    let t = (value - min) / (max - min);
    (t.clamp(0.0, 1.0) * QUANTIZED_MAX as f64).round() as u16
}

/// Quantize a height value to 0-32767 range.
#[inline]
fn quantize_height(height: f64, min_height: f64, max_height: f64) -> u16 {
    let t = (height - min_height) / (max_height - min_height);
    (t.clamp(0.0, 1.0) * QUANTIZED_MAX as f64).round() as u16
}

/// Compute vertex normals for the mesh.
fn compute_vertex_normals(
    vertices: &QuantizedVertices,
    indices: &[u32],
    bounds: &TileBounds,
    min_height: f64,
    max_height: f64,
) -> Vec<[f32; 3]> {
    let vertex_count = vertices.len();
    let mut normals = vec![[0.0f32; 3]; vertex_count];

    // Convert quantized vertices to ECEF positions
    let positions: Vec<[f64; 3]> = (0..vertex_count)
        .map(|i| {
            let u = vertices.u[i] as f64 / QUANTIZED_MAX as f64;
            let v = vertices.v[i] as f64 / QUANTIZED_MAX as f64;
            let h = vertices.height[i] as f64 / QUANTIZED_MAX as f64;

            let lon = bounds.west + u * (bounds.east - bounds.west);
            let lat = bounds.south + v * (bounds.north - bounds.south);
            let height = min_height + h * (max_height - min_height);

            geodetic_to_ecef(lon, lat, height)
        })
        .collect();

    // Accumulate face normals to vertices
    for tri in indices.chunks(3) {
        if tri.len() < 3 {
            continue;
        }

        let i0 = tri[0] as usize;
        let i1 = tri[1] as usize;
        let i2 = tri[2] as usize;

        let p0 = &positions[i0];
        let p1 = &positions[i1];
        let p2 = &positions[i2];

        // Face normal via (p1-p0) x (p2-p0). With Martini's CCW winding
        // (when viewed from outside the ellipsoid) this gives an
        // outward-facing normal, which is Cesium's convention.
        let v1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        let v2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];

        let normal = [
            (v1[1] * v2[2] - v1[2] * v2[1]) as f32,
            (v1[2] * v2[0] - v1[0] * v2[2]) as f32,
            (v1[0] * v2[1] - v1[1] * v2[0]) as f32,
        ];

        // Add to vertex normals
        for &idx in &[i0, i1, i2] {
            normals[idx][0] += normal[0];
            normals[idx][1] += normal[1];
            normals[idx][2] += normal[2];
        }
    }

    // Normalize all normals
    for normal in &mut normals {
        let len = (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
        if len > 1e-6 {
            normal[0] /= len;
            normal[1] /= len;
            normal[2] /= len;
        } else {
            // Default to up vector
            *normal = [0.0, 0.0, 1.0];
        }
    }

    normals
}

/// Compute vertex normals from the DEM gradient on a halo-extended grid.
///
/// For every vertex the local east/north slope is read from the same DEM
/// samples that the neighbour tile would read — so the same physical edge
/// sees the same gradient from either side, eliminating the tile-boundary
/// shading seam that `compute_vertex_normals` exhibits.
///
/// Pipeline:
///   1. Map the vertex's (u, v) into the halo grid's index space.
///   2. Sample the halo grid bilinearly at a half-cell stencil to get
///      central differences `∂h/∂x` and `∂h/∂y` in metres.
///   3. Build a local ENU normal `(-∂h/∂x, -∂h/∂y, 1)` and rotate it into
///      ECEF, which is what Cesium expects for oct-encoded normals.
fn compute_vertex_normals_from_gradient(
    vertices: &QuantizedVertices,
    bounds: &TileBounds,
    halo: &HaloElevations,
) -> Vec<[f32; 3]> {
    let vertex_count = vertices.len();
    let halo_cells = halo.halo as usize;
    let grid_size = MESH_GRID_SIZE as usize;
    let halo_grid_size = grid_size + 2 * halo_cells;
    debug_assert_eq!(
        halo.elevations.len(),
        halo_grid_size * halo_grid_size,
        "halo grid must be {halo_grid_size}×{halo_grid_size}",
    );

    let tile_lon_span = bounds.east - bounds.west;
    let tile_lat_span = bounds.north - bounds.south;
    // Cells = (grid_size - 1) inside the tile; halo adds `halo_cells` cells
    // on each side, so the per-cell step in degrees is unchanged.
    let cell_lon_deg = tile_lon_span / (grid_size as f64 - 1.0);
    let cell_lat_deg = tile_lat_span / (grid_size as f64 - 1.0);

    // Metres per degree at the tile centre — good enough since a single
    // 65×65 tile is small relative to Earth's radius.
    const WGS84_A: f64 = 6_378_137.0;
    let centre_lat = (bounds.south + bounds.north) * 0.5;
    let m_per_deg_lat = WGS84_A * std::f64::consts::PI / 180.0;
    let m_per_deg_lon = m_per_deg_lat * centre_lat.to_radians().cos();
    let cell_m_x = cell_lon_deg * m_per_deg_lon;
    let cell_m_y = cell_lat_deg * m_per_deg_lat;

    let height_at = |fx: f64, fy: f64| -> f64 {
        // Clamp to the halo grid so vertices on the absolute tile edge can
        // still read their +/-1 neighbours via the halo cells.
        let max_idx = (halo_grid_size - 1) as f64;
        let fx = fx.clamp(0.0, max_idx);
        let fy = fy.clamp(0.0, max_idx);
        let x0 = fx.floor() as usize;
        let y0 = fy.floor() as usize;
        let x1 = (x0 + 1).min(halo_grid_size - 1);
        let y1 = (y0 + 1).min(halo_grid_size - 1);
        let tx = fx - x0 as f64;
        let ty = fy - y0 as f64;
        let h00 = halo.elevations[y0 * halo_grid_size + x0];
        let h10 = halo.elevations[y0 * halo_grid_size + x1];
        let h01 = halo.elevations[y1 * halo_grid_size + x0];
        let h11 = halo.elevations[y1 * halo_grid_size + x1];
        // NaN-tolerant bilinear: fall back to any defined corner.
        let bilerp = |a: f64, b: f64, t: f64| -> f64 {
            if a.is_nan() {
                b
            } else if b.is_nan() {
                a
            } else {
                a * (1.0 - t) + b * t
            }
        };
        let top = bilerp(h00, h10, tx);
        let bot = bilerp(h01, h11, tx);
        let v = bilerp(top, bot, ty);
        if v.is_nan() { 0.0 } else { v }
    };

    let mut normals = Vec::with_capacity(vertex_count);
    for i in 0..vertex_count {
        let u_norm = vertices.u[i] as f64 / QUANTIZED_MAX as f64;
        let v_norm = vertices.v[i] as f64 / QUANTIZED_MAX as f64;
        let lon = bounds.west + u_norm * tile_lon_span;
        let lat = bounds.south + v_norm * tile_lat_span;

        // Index space in the halo grid:
        //   u_norm = 0 (tile west) ↔ halo x index `halo_cells`
        //   u_norm = 1 (tile east) ↔ halo x index `halo_cells + grid_size - 1`
        // Row index increases SOUTHWARD (north→south layout), so v_norm = 1
        // (tile north) maps to halo y index `halo_cells`.
        let fx_center = halo_cells as f64 + u_norm * (grid_size as f64 - 1.0);
        let fy_center = halo_cells as f64 + (1.0 - v_norm) * (grid_size as f64 - 1.0);

        // Central differences with a half-cell step. Bilinear interpolation
        // is exact at integer offsets, so the effective stencil width is
        // one cell — same as the neighbour tile's view of the same point.
        let h_west = height_at(fx_center - 0.5, fy_center);
        let h_east = height_at(fx_center + 0.5, fy_center);
        let h_north = height_at(fx_center, fy_center - 0.5);
        let h_south = height_at(fx_center, fy_center + 0.5);

        let dh_dx = (h_east - h_west) / cell_m_x; // east-positive
        let dh_dy = (h_north - h_south) / cell_m_y; // north-positive

        // Local ENU normal of z = h(x, y): gradient is (dh/dx, dh/dy), the
        // outward normal is (-grad, 1). Length doesn't matter — we
        // normalise after rotating to ECEF.
        let nx_enu = -dh_dx;
        let ny_enu = -dh_dy;
        let nz_enu = 1.0;

        // Rotate ENU → ECEF using the local east/north/up basis at (lat, lon).
        let lat_rad = lat.to_radians();
        let lon_rad = lon.to_radians();
        let (sin_lat, cos_lat) = lat_rad.sin_cos();
        let (sin_lon, cos_lon) = lon_rad.sin_cos();
        // east  = (-sin_lon,           cos_lon,            0)
        // north = (-sin_lat*cos_lon,  -sin_lat*sin_lon,    cos_lat)
        // up    = ( cos_lat*cos_lon,   cos_lat*sin_lon,    sin_lat)
        let ex = nx_enu * (-sin_lon) + ny_enu * (-sin_lat * cos_lon) + nz_enu * (cos_lat * cos_lon);
        let ey = nx_enu * cos_lon + ny_enu * (-sin_lat * sin_lon) + nz_enu * (cos_lat * sin_lon);
        let ez = ny_enu * cos_lat + nz_enu * sin_lat;

        let len = (ex * ex + ey * ey + ez * ez).sqrt();
        if len > 1e-12 {
            normals.push([(ex / len) as f32, (ey / len) as f32, (ez / len) as f32]);
        } else {
            // Degenerate — should never happen since the `up` component is
            // always ≥ cos(max slope), but be defensive.
            normals.push([
                (cos_lat * cos_lon) as f32,
                (cos_lat * sin_lon) as f32,
                sin_lat as f32,
            ]);
        }
    }

    normals
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_height_range() {
        let elevations = vec![10.0, 20.0, 30.0, 40.0];
        let (min, max) = find_height_range(&elevations);
        assert_eq!(min, 10.0);
        assert_eq!(max, 40.0);
    }

    #[test]
    fn test_find_height_range_with_nan() {
        let elevations = vec![10.0, f64::NAN, 30.0, f64::NAN];
        let (min, max) = find_height_range(&elevations);
        assert_eq!(min, 10.0);
        assert_eq!(max, 30.0);
    }

    #[test]
    fn test_find_height_range_all_nan() {
        let elevations = vec![f64::NAN, f64::NAN];
        let (min, max) = find_height_range(&elevations);
        assert_eq!(min, 0.0);
        assert!(max > min);
    }

    #[test]
    fn test_quantize_coordinate() {
        assert_eq!(quantize_coordinate(0.0, 0.0, 100.0), 0);
        assert_eq!(quantize_coordinate(100.0, 0.0, 100.0), QUANTIZED_MAX);
        // 50.0 / 100.0 * 32767 = 16383.5, which rounds to 16384
        let mid = quantize_coordinate(50.0, 0.0, 100.0);
        assert!(mid == QUANTIZED_MAX / 2 || mid == QUANTIZED_MAX / 2 + 1);
    }

    #[test]
    fn test_generate_flat_terrain() {
        let grid_size = MESH_GRID_SIZE as usize;
        let elevations = vec![100.0; grid_size * grid_size];

        let bounds = TileBounds::new(139.0, 35.0, 140.0, 36.0);
        let options = QuantizedMeshOptions {
            max_error: 0.0,
            compression_level: 0, // No compression for easier testing
            ..Default::default()
        };

        let tile = generate_quantized_mesh_tile(&elevations, &bounds, &options);

        // With fixed edges enabled, even flat terrain has many triangles because
        // all edge vertices must be included for seamless tiling.
        // For a 65x65 grid with fixed edges, we expect roughly 920 triangles.
        assert!(tile.triangle_count > 0);
        assert!(tile.vertex_count > 0);
        assert!(!tile.data.is_empty());
    }

    #[test]
    fn test_generate_varied_terrain() {
        let grid_size = MESH_GRID_SIZE as usize;
        let mut elevations = Vec::with_capacity(grid_size * grid_size);

        // Create varied terrain
        for y in 0..grid_size {
            for x in 0..grid_size {
                let h = ((x as f64 / 10.0).sin() * (y as f64 / 10.0).cos() * 100.0) + 500.0;
                elevations.push(h);
            }
        }

        let bounds = TileBounds::new(139.0, 35.0, 140.0, 36.0);
        let options = QuantizedMeshOptions {
            max_error: 5.0,
            compression_level: 0,
            ..Default::default()
        };

        let tile = generate_quantized_mesh_tile(&elevations, &bounds, &options);

        // Varied terrain should produce more triangles
        assert!(tile.triangle_count > 2);
        assert!(tile.vertex_count > 4);
    }

    #[test]
    fn test_generate_with_normals() {
        let grid_size = MESH_GRID_SIZE as usize;
        let elevations = vec![100.0; grid_size * grid_size];

        let bounds = TileBounds::new(139.0, 35.0, 140.0, 36.0);
        let options = QuantizedMeshOptions {
            max_error: 0.0,
            include_normals: true,
            compression_level: 0,
            ..Default::default()
        };

        let tile = generate_quantized_mesh_tile(&elevations, &bounds, &options);

        // With normals, data should be larger
        let options_no_normals = QuantizedMeshOptions {
            include_normals: false,
            ..options.clone()
        };
        let tile_no_normals =
            generate_quantized_mesh_tile(&elevations, &bounds, &options_no_normals);

        assert!(tile.data.len() > tile_no_normals.data.len());
    }

    #[test]
    fn test_generate_with_compression() {
        let grid_size = MESH_GRID_SIZE as usize;
        let elevations = vec![100.0; grid_size * grid_size];

        let bounds = TileBounds::new(139.0, 35.0, 140.0, 36.0);

        let options_uncompressed = QuantizedMeshOptions {
            compression_level: 0,
            ..Default::default()
        };
        let _tile_uncompressed =
            generate_quantized_mesh_tile(&elevations, &bounds, &options_uncompressed);

        let options_compressed = QuantizedMeshOptions {
            compression_level: 6,
            ..Default::default()
        };
        let tile_compressed =
            generate_quantized_mesh_tile(&elevations, &bounds, &options_compressed);

        // Compressed should be smaller or have gzip header
        assert_eq!(&tile_compressed.data[0..2], &[0x1f, 0x8b]); // gzip magic
    }

    /// A perfectly tilted plane h(x, y) = a*x + b*y has a constant ENU
    /// normal everywhere. The halo-gradient path should reproduce that
    /// analytical normal (within float tolerance) for every vertex.
    #[test]
    fn test_halo_gradient_normals_match_analytical_plane() {
        let grid_size = MESH_GRID_SIZE as usize;
        let halo = 1usize;
        let halo_grid_size = grid_size + 2 * halo;

        // ~1 km square near Tokyo so ENU→ECEF rotation does real work.
        let bounds = TileBounds::new(139.0, 35.0, 139.01, 35.01);
        let centre_lat = 35.005_f64;

        const WGS84_A: f64 = 6_378_137.0;
        let m_per_deg_lat = WGS84_A * std::f64::consts::PI / 180.0;
        let m_per_deg_lon = m_per_deg_lat * centre_lat.to_radians().cos();
        let cell_lon_deg = (bounds.east - bounds.west) / (grid_size as f64 - 1.0);
        let cell_lat_deg = (bounds.north - bounds.south) / (grid_size as f64 - 1.0);
        let cell_m_x = cell_lon_deg * m_per_deg_lon;
        let cell_m_y = cell_lat_deg * m_per_deg_lat;

        // 5 m east-rise per cell, 3 m north-rise per cell.
        let dh_dx = 5.0 / cell_m_x;
        let dh_dy = 3.0 / cell_m_y;

        // Build a plane on the halo grid. Row 0 is north → larger j means
        // smaller y in ENU, so reverse j when computing y.
        let mut halo_grid = Vec::with_capacity(halo_grid_size * halo_grid_size);
        for j in 0..halo_grid_size {
            for i in 0..halo_grid_size {
                let x = (i as f64 - halo as f64) * cell_m_x;
                let y = ((halo_grid_size - 1 - j) as f64 - halo as f64) * cell_m_y;
                halo_grid.push(dh_dx * x + dh_dy * y + 100.0);
            }
        }

        // Hand-construct a few vertices spread across the tile.
        let mut vertices = QuantizedVertices::with_capacity(9);
        for v_q in [0u16, QUANTIZED_MAX / 2, QUANTIZED_MAX] {
            for u_q in [0u16, QUANTIZED_MAX / 2, QUANTIZED_MAX] {
                vertices.push(u_q, v_q, 0);
            }
        }

        let halo_elev = HaloElevations {
            elevations: halo_grid,
            halo: halo as u32,
        };
        let normals = compute_vertex_normals_from_gradient(&vertices, &bounds, &halo_elev);

        // Expected ENU normal of the plane (constant).
        let n_enu = {
            let v = [-dh_dx, -dh_dy, 1.0];
            let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            [v[0] / len, v[1] / len, v[2] / len]
        };

        for (i, n) in normals.iter().enumerate() {
            let u_norm = vertices.u[i] as f64 / QUANTIZED_MAX as f64;
            let v_norm = vertices.v[i] as f64 / QUANTIZED_MAX as f64;
            let lon = bounds.west + u_norm * (bounds.east - bounds.west);
            let lat = bounds.south + v_norm * (bounds.north - bounds.south);
            let lat_rad = lat.to_radians();
            let lon_rad = lon.to_radians();
            let (sin_lat, cos_lat) = lat_rad.sin_cos();
            let (sin_lon, cos_lon) = lon_rad.sin_cos();
            // Project the ECEF normal back to ENU and compare.
            let nx = n[0] as f64;
            let ny = n[1] as f64;
            let nz = n[2] as f64;
            let east_c = -sin_lon * nx + cos_lon * ny;
            let north_c =
                -sin_lat * cos_lon * nx + -sin_lat * sin_lon * ny + cos_lat * nz;
            let up_c = cos_lat * cos_lon * nx + cos_lat * sin_lon * ny + sin_lat * nz;
            let diff = (east_c - n_enu[0]).abs()
                + (north_c - n_enu[1]).abs()
                + (up_c - n_enu[2]).abs();
            assert!(
                diff < 1e-3,
                "vertex {i}: ENU normal mismatch (got [{east_c}, {north_c}, {up_c}], expected {n_enu:?})",
            );
        }
    }

    /// Two adjacent tiles sharing an east/west edge: with halo-gradient
    /// normals, the seam vertices should get bit-identical normals because
    /// they read the same DEM samples from the shared halo strip.
    #[test]
    fn test_halo_gradient_normals_match_across_tile_seam() {
        let grid_size = MESH_GRID_SIZE as usize;
        let halo = 1usize;
        let halo_grid_size = grid_size + 2 * halo;

        // Two adjacent tiles at the same latitude band.
        let bounds_west = TileBounds::new(139.00, 35.0, 139.01, 35.01);
        let bounds_east = TileBounds::new(139.01, 35.0, 139.02, 35.01);

        // A simple ridge running east, h = sin(lon) * 50 + cos(lat) * 30.
        // Both tiles' halo grids cover the seam lon and read the same
        // values from this analytic field, so seam normals must match.
        let height_field = |lon: f64, lat: f64| -> f64 {
            (lon * 100.0).sin() * 50.0 + (lat * 80.0).cos() * 30.0
        };
        let cell_lon = (bounds_west.east - bounds_west.west) / (grid_size as f64 - 1.0);
        let cell_lat = (bounds_west.north - bounds_west.south) / (grid_size as f64 - 1.0);

        let make_halo = |b: &TileBounds| -> Vec<f64> {
            let mut out = Vec::with_capacity(halo_grid_size * halo_grid_size);
            for j in 0..halo_grid_size {
                let lat = b.north + cell_lat * halo as f64
                    - (j as f64) * cell_lat;
                for i in 0..halo_grid_size {
                    let lon = b.west - cell_lon * halo as f64
                        + (i as f64) * cell_lon;
                    out.push(height_field(lon, lat));
                }
            }
            out
        };

        let halo_w = HaloElevations { elevations: make_halo(&bounds_west), halo: halo as u32 };
        let halo_e = HaloElevations { elevations: make_halo(&bounds_east), halo: halo as u32 };

        // Seam vertex positions along v ∈ {0, mid, max}, on:
        //   west tile's east edge (u = 32767)
        //   east tile's west edge (u = 0)
        let mut v_west = QuantizedVertices::with_capacity(3);
        let mut v_east = QuantizedVertices::with_capacity(3);
        for v_q in [0u16, QUANTIZED_MAX / 2, QUANTIZED_MAX] {
            v_west.push(QUANTIZED_MAX, v_q, 0);
            v_east.push(0, v_q, 0);
        }

        let n_west = compute_vertex_normals_from_gradient(&v_west, &bounds_west, &halo_w);
        let n_east = compute_vertex_normals_from_gradient(&v_east, &bounds_east, &halo_e);

        for (i, (a, b)) in n_west.iter().zip(n_east.iter()).enumerate() {
            let dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) as f64;
            assert!(
                dot > 0.999_999,
                "seam vertex {i}: normals diverged (dot = {dot})\nwest = {a:?}\neast = {b:?}",
            );
        }
    }
}
