//! WASM bindings that expose the [`terrain_codec`] crate to the
//! Re:Earth Terrain Cloudflare Worker. All heavy lifting (heightmap
//! codecs, RTIN meshing, seamless normals) lives in the upstream crate
//! — this file is just a thin wasm-bindgen surface that matches what
//! the TypeScript side calls.

use image::ImageEncoder;
use terrain_codec::heightmap::container::{
    decode_image, rgb_to_png as container_rgb_to_png, rgb_to_webp as container_rgb_to_webp,
};
use terrain_codec::heightmap::{self, HeightmapFormat};
use terrain_codec::martini::Martini;
use terrain_codec::normals::{BufferedElevations, buffered_gradient_normals, face_normals};
use terrain_codec::quantized_mesh::{
    EdgeIndices, EncodeOptions, QUANTIZED_MAX, QuantizedMeshEncoder, QuantizedMeshHeader,
    QuantizedVertices, TileBounds, WaterMask,
};
use wasm_bindgen::prelude::*;

/// Grid size used by `encode_quantized_mesh`. Must match
/// `MESH_GRID_SIZE` on the TypeScript side.
const MESH_GRID_SIZE: u32 = 65;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
pub fn add(a: u32, b: u32) -> u32 {
    a + b
}

// ---------- Cesium quantized-mesh-1.0 ----------

/// Generate a gzipped Cesium quantized-mesh-1.0 tile from elevation data.
///
/// `elevations` is a row-major 65x65 grid (north-to-south, west-to-east),
/// values in meters above the WGS84 ellipsoid. `west / south / east / north`
/// are the tile's geodetic bounds in degrees. `max_error` is the Martini
/// simplification threshold in meters — lower means more triangles.
///
/// Optional extensions:
/// * `include_normals` - emit per-vertex oct-encoded normals for lighting.
/// * `water_mask` - empty slice = no watermask; 1 byte = uniform mask
///   (0 = all land, 255 = all water); 65536 bytes = 256x256 grid mask.
/// * `halo_elevations` / `halo_cells` - when non-empty, normals are
///   computed from the DEM gradient on this halo-extended grid (size
///   `(65 + 2*halo_cells)²`) instead of from face-normal accumulation.
///   Empty slice / `halo_cells = 0` falls back to the legacy face-normal
///   path.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn encode_quantized_mesh(
    elevations: &[f64],
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    max_error: f64,
    compression_level: u32,
    include_normals: bool,
    water_mask: &[u8],
    // Taken by-value so wasm-bindgen hands us ownership of the Vec it
    // already allocated to receive the JS Float64Array — we hand that
    // straight to `BufferedElevations::new` without an extra `.to_vec()`.
    halo_elevations: Vec<f64>,
    halo_cells: u32,
) -> Vec<u8> {
    let bounds = TileBounds::new(west, south, east, north);
    let grid_size = MESH_GRID_SIZE as usize;
    assert!(
        elevations.len() >= grid_size * grid_size,
        "encode_quantized_mesh: expected at least {} elevation values, got {}",
        grid_size * grid_size,
        elevations.len()
    );

    let water_mask = match water_mask.len() {
        0 => None,
        1 => Some(WaterMask::Uniform(water_mask[0])),
        len if len == 256 * 256 => Some(WaterMask::from_data(water_mask)),
        _ => None, // malformed — drop the extension
    };
    let include_water_mask = water_mask.is_some();

    let buffered = if include_normals && halo_cells > 0 && !halo_elevations.is_empty() {
        let side = grid_size + 2 * halo_cells as usize;
        if halo_elevations.len() == side * side {
            Some(BufferedElevations::new(
                halo_elevations,
                MESH_GRID_SIZE,
                halo_cells,
            ))
        } else {
            None
        }
    } else {
        None
    };

    let (min_height, max_height) = find_height_range(elevations);

    // Build the RTIN mesh via Martini.
    let mut martini = Martini::new(MESH_GRID_SIZE);
    let tile = martini.create_terrain(|x, y| {
        let idx = y * grid_size + x;
        let h = elevations.get(idx).copied().unwrap_or(0.0);
        if h.is_nan() { 0.0 } else { h }
    });
    let (vertices_flat, indices, _uvs) =
        tile.construct_mesh(&mut martini, max_error, &mut |(u, v)| {
            let lon = bounds.west + u * (bounds.east - bounds.west);
            let lat = bounds.south + v * (bounds.north - bounds.south);
            let px = (u * (grid_size - 1) as f64).round() as usize;
            let py = ((1.0 - v) * (grid_size - 1) as f64).round() as usize;
            let idx = py.min(grid_size - 1) * grid_size + px.min(grid_size - 1);
            let height = elevations.get(idx).copied().unwrap_or(0.0);
            let height = if height.is_nan() { 0.0 } else { height };
            (lon, lat, height)
        });

    // Quantize to (u, v, h) ∈ [0, 32767].
    let vertex_count = vertices_flat.len() / 3;
    let mut vertices = QuantizedVertices::with_capacity(vertex_count);
    for i in 0..vertex_count {
        let lon = vertices_flat[i * 3] as f64;
        let lat = vertices_flat[i * 3 + 1] as f64;
        let h = vertices_flat[i * 3 + 2] as f64;
        vertices.push(
            quantize(lon, bounds.west, bounds.east),
            quantize(lat, bounds.south, bounds.north),
            quantize(h, min_height, max_height),
        );
    }

    let edge_indices = EdgeIndices::from_vertices(&vertices);

    // Tight horizon-occlusion point: stream the actual mesh vertices
    // straight from the flat Vec<f32> so Cesium doesn't false-cull
    // tiles near the bounding sphere's equator. The iter API avoids
    // materialising an intermediate Vec<[f64; 3]>.
    let header = QuantizedMeshHeader::from_bounds_with_vertices_iter(
        &bounds,
        min_height as f32,
        max_height as f32,
        vertices_flat
            .chunks_exact(3)
            .map(|c| [c[0] as f64, c[1] as f64, c[2] as f64]),
    );

    let normals = if include_normals {
        Some(match &buffered {
            Some(b) => buffered_gradient_normals(&vertices, &bounds, b),
            None => face_normals(&vertices, &indices, &bounds, min_height, max_height),
        })
    } else {
        None
    };

    let encoder = QuantizedMeshEncoder::new(header, vertices, indices, edge_indices);
    encoder.encode_with_options(&EncodeOptions {
        include_normals,
        normals,
        include_water_mask,
        water_mask,
        include_metadata: false,
        metadata: None,
        compression_level,
    })
}

fn find_height_range(elevations: &[f64]) -> (f64, f64) {
    let mut min_height = f64::MAX;
    let mut max_height = f64::MIN;
    for &h in elevations {
        if !h.is_nan() {
            min_height = min_height.min(h);
            max_height = max_height.max(h);
        }
    }
    if min_height > max_height {
        min_height = 0.0;
        max_height = 0.0;
    }
    if (max_height - min_height).abs() < 1e-6 {
        max_height = min_height + 1.0;
    }
    (min_height, max_height)
}

#[inline]
fn quantize(value: f64, min: f64, max: f64) -> u16 {
    let t = (value - min) / (max - min);
    (t.clamp(0.0, 1.0) * QUANTIZED_MAX as f64).round() as u16
}

// ---------- Heightmap RGB codecs ----------

/// Encode elevation values (meters) as Terrarium-style RGB bytes.
#[wasm_bindgen]
pub fn encode_terrarium(elevations: &[f32], width: u32, height: u32) -> Vec<u8> {
    heightmap::encode(HeightmapFormat::Terrarium, elevations, width, height)
}

/// Encode elevation values as Mapbox Terrain-RGB.
#[wasm_bindgen]
pub fn encode_mapbox(elevations: &[f32], width: u32, height: u32) -> Vec<u8> {
    heightmap::encode(HeightmapFormat::Mapbox, elevations, width, height)
}

// ---------- Image container encoders ----------

#[wasm_bindgen]
pub fn rgb_to_webp(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsError> {
    container_rgb_to_webp(rgb, width, height)
        .map_err(|e| JsError::new(&format!("webp encode failed: {e}")))
}

#[wasm_bindgen]
pub fn rgb_to_png(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsError> {
    container_rgb_to_png(rgb, width, height)
        .map_err(|e| JsError::new(&format!("png encode failed: {e}")))
}

#[wasm_bindgen]
pub fn rgba_to_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsError> {
    assert_rgba_len(rgba, width, height)?;
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| JsError::new(&format!("png encode failed: {e}")))?;
    Ok(out)
}

#[wasm_bindgen]
pub fn rgba_to_webp(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsError> {
    assert_rgba_len(rgba, width, height)?;
    let mut out = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut out)
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| JsError::new(&format!("webp encode failed: {e}")))?;
    Ok(out)
}

fn assert_rgba_len(rgba: &[u8], width: u32, height: u32) -> Result<(), JsError> {
    let expected = (width as usize) * (height as usize) * 4;
    if rgba.len() != expected {
        return Err(JsError::new(&format!(
            "rgba length {} does not match {}x{}x4 = {}",
            rgba.len(),
            width,
            height,
            expected
        )));
    }
    Ok(())
}

// ---------- Terrarium image decoders ----------

#[wasm_bindgen]
pub struct DecodedTile {
    width: u32,
    height: u32,
    elevations: Vec<f32>,
}

#[wasm_bindgen]
impl DecodedTile {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
    /// Consumes the struct; wasm-bindgen converts to a Float32Array.
    #[wasm_bindgen(getter)]
    pub fn elevations(self) -> Vec<f32> {
        self.elevations
    }
}

#[wasm_bindgen]
pub fn decode_terrarium_webp(bytes: &[u8]) -> Result<DecodedTile, JsError> {
    decode_terrarium_image(bytes)
}

#[wasm_bindgen]
pub fn decode_terrarium_png(bytes: &[u8]) -> Result<DecodedTile, JsError> {
    decode_terrarium_image(bytes)
}

fn decode_terrarium_image(bytes: &[u8]) -> Result<DecodedTile, JsError> {
    let decoded =
        decode_image(bytes).map_err(|e| JsError::new(&format!("image decode failed: {e}")))?;
    let elevations = heightmap::decode(
        HeightmapFormat::Terrarium,
        &decoded.rgb,
        decoded.width,
        decoded.height,
    );
    Ok(DecodedTile {
        width: decoded.width,
        height: decoded.height,
        elevations,
    })
}
