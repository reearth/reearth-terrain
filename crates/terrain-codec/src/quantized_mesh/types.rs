//! Type definitions for quantized-mesh format.

/// Maximum value for quantized coordinates (2^15 - 1).
pub const QUANTIZED_MAX: u16 = 32767;

/// Quantized vertex data.
///
/// Each coordinate is quantized to 0-32767 range:
/// - `u`: horizontal position (0 = west edge, 32767 = east edge)
/// - `v`: vertical position (0 = south edge, 32767 = north edge)
/// - `height`: elevation (0 = min height, 32767 = max height)
#[derive(Debug, Clone, Default)]
pub struct QuantizedVertices {
    /// Horizontal coordinates (0 = west, 32767 = east)
    pub u: Vec<u16>,
    /// Vertical coordinates (0 = south, 32767 = north)
    pub v: Vec<u16>,
    /// Height values (0 = min, 32767 = max)
    pub height: Vec<u16>,
}

impl QuantizedVertices {
    /// Create new empty vertices.
    pub fn new() -> Self {
        Self::default()
    }

    /// Create vertices with pre-allocated capacity.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            u: Vec::with_capacity(capacity),
            v: Vec::with_capacity(capacity),
            height: Vec::with_capacity(capacity),
        }
    }

    /// Get vertex count.
    pub fn len(&self) -> usize {
        self.u.len()
    }

    /// Check if empty.
    pub fn is_empty(&self) -> bool {
        self.u.is_empty()
    }

    /// Add a vertex.
    pub fn push(&mut self, u: u16, v: u16, height: u16) {
        self.u.push(u);
        self.v.push(v);
        self.height.push(height);
    }
}

/// Edge indices for skirt generation.
///
/// Contains indices of vertices on each edge of the tile,
/// sorted by their position along the edge.
#[derive(Debug, Clone, Default)]
pub struct EdgeIndices {
    /// Indices of vertices on the west edge (sorted by v, ascending)
    pub west: Vec<u32>,
    /// Indices of vertices on the south edge (sorted by u, ascending)
    pub south: Vec<u32>,
    /// Indices of vertices on the east edge (sorted by v, ascending)
    pub east: Vec<u32>,
    /// Indices of vertices on the north edge (sorted by u, ascending)
    pub north: Vec<u32>,
}

impl EdgeIndices {
    /// Create new empty edge indices.
    pub fn new() -> Self {
        Self::default()
    }

    /// Extract edge indices from vertex data.
    ///
    /// Identifies vertices on tile boundaries (u=0, u=32767, v=0, v=32767)
    /// and sorts them appropriately.
    pub fn from_vertices(vertices: &QuantizedVertices) -> Self {
        let mut west = Vec::new();
        let mut south = Vec::new();
        let mut east = Vec::new();
        let mut north = Vec::new();

        for (i, (&u, &v)) in vertices.u.iter().zip(vertices.v.iter()).enumerate() {
            let idx = i as u32;
            if u == 0 {
                west.push((idx, v));
            }
            if u == QUANTIZED_MAX {
                east.push((idx, v));
            }
            if v == 0 {
                south.push((idx, u));
            }
            if v == QUANTIZED_MAX {
                north.push((idx, u));
            }
        }

        // Sort by position along edge
        west.sort_by_key(|&(_, v)| v);
        east.sort_by_key(|&(_, v)| v);
        south.sort_by_key(|&(_, u)| u);
        north.sort_by_key(|&(_, u)| u);

        Self {
            west: west.into_iter().map(|(idx, _)| idx).collect(),
            south: south.into_iter().map(|(idx, _)| idx).collect(),
            east: east.into_iter().map(|(idx, _)| idx).collect(),
            north: north.into_iter().map(|(idx, _)| idx).collect(),
        }
    }
}

/// Extension IDs for quantized-mesh format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ExtensionId {
    /// Oct-encoded per-vertex normals (2 bytes per vertex)
    OctEncodedVertexNormals = 1,
    /// Water mask (1 byte or 256x256 bytes)
    WaterMask = 2,
    /// JSON metadata
    Metadata = 4,
}

/// Water mask data.
#[derive(Debug, Clone)]
pub enum WaterMask {
    /// Uniform mask: single byte (0 = all land, 255 = all water)
    Uniform(u8),
    /// Grid mask: 256x256 bytes
    Grid(Box<[u8; 256 * 256]>),
}

impl Default for WaterMask {
    fn default() -> Self {
        Self::Uniform(0) // All land
    }
}

impl WaterMask {
    /// Create water mask from 256x256 grayscale data.
    ///
    /// If all values are the same, returns `Uniform`.
    /// Otherwise, returns `Grid` with the 256x256 data.
    pub fn from_data(data: &[u8]) -> Self {
        if data.len() < 256 * 256 {
            return Self::Uniform(0); // Fallback to all land
        }

        // Check if all values are the same
        if let Some(&first) = data.first()
            && data[..256 * 256].iter().all(|&v| v == first)
        {
            return Self::Uniform(first);
        }

        // Create grid
        let mut grid = Box::new([0u8; 256 * 256]);
        grid.copy_from_slice(&data[..256 * 256]);
        Self::Grid(grid)
    }
}

/// Tile availability range for metadata extension.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableRange {
    /// Starting X coordinate (inclusive)
    pub start_x: u32,
    /// Ending X coordinate (inclusive)
    pub end_x: u32,
    /// Starting Y coordinate (inclusive)
    pub start_y: u32,
    /// Ending Y coordinate (inclusive)
    pub end_y: u32,
}

impl AvailableRange {
    /// Create a new availability range.
    pub fn new(start_x: u32, end_x: u32, start_y: u32, end_y: u32) -> Self {
        Self {
            start_x,
            end_x,
            start_y,
            end_y,
        }
    }

    /// Create a range covering the full level (global-geodetic).
    ///
    /// For Cesium's global-geodetic TMS, at zoom level z:
    /// - X: 0 to 2^(z+1) - 1
    /// - Y: 0 to 2^z - 1
    pub fn full_level_geodetic(zoom: u8) -> Self {
        let max_x = (1u32 << (zoom + 1)) - 1;
        let max_y = (1u32 << zoom) - 1;
        Self {
            start_x: 0,
            end_x: max_x,
            start_y: 0,
            end_y: max_y,
        }
    }
}

/// Metadata for quantized-mesh extension.
///
/// Contains child tile availability information.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TileMetadata {
    /// Available tile ranges by zoom level offset from current tile.
    /// Level 0 is one level below current tile (children).
    /// Level 1 is two levels below (grandchildren), etc.
    pub available: Vec<Vec<AvailableRange>>,
}

impl TileMetadata {
    /// Create new empty metadata.
    pub fn new() -> Self {
        Self {
            available: Vec::new(),
        }
    }

    /// Create metadata indicating all children are available for `levels` more zoom levels.
    ///
    /// This is useful for tiles where we know all descendants exist up to a certain depth.
    #[deprecated(note = "Use for_tile instead, which computes correct child tile ranges")]
    pub fn all_available(current_zoom: u8, max_zoom: u8) -> Self {
        let mut available = Vec::new();

        // For each child level from current+1 to max_zoom
        for child_zoom in (current_zoom + 1)..=max_zoom {
            available.push(vec![AvailableRange::full_level_geodetic(child_zoom)]);
        }

        Self { available }
    }

    /// Create metadata for a specific tile indicating all descendants are available.
    ///
    /// # Arguments
    /// * `tile_x` - X coordinate of the current tile
    /// * `tile_y` - Y coordinate of the current tile
    /// * `current_zoom` - Zoom level of the current tile
    /// * `max_zoom` - Maximum zoom level to include in metadata
    ///
    /// The metadata contains availability ranges for descendant tiles relative to this tile.
    /// For geodetic TMS, each tile at zoom z has 4 children at zoom z+1.
    pub fn for_tile(tile_x: u32, tile_y: u32, current_zoom: u8, max_zoom: u8) -> Self {
        let mut available = Vec::new();

        // For each descendant level from current+1 to max_zoom
        for child_zoom in (current_zoom + 1)..=max_zoom {
            // Calculate how many levels deep we are from the current tile
            let levels_deep = child_zoom - current_zoom;
            let scale = 1u32 << levels_deep; // 2^levels_deep

            // Calculate the range of descendant tiles
            // At each level, the tile range doubles
            let start_x = tile_x * scale;
            let start_y = tile_y * scale;
            let end_x = start_x + scale - 1;
            let end_y = start_y + scale - 1;

            available.push(vec![AvailableRange::new(start_x, end_x, start_y, end_y)]);
        }

        Self { available }
    }
}

impl Default for TileMetadata {
    fn default() -> Self {
        Self::new()
    }
}

/// Tile bounds in geographic coordinates (degrees).
#[derive(Debug, Clone, Copy)]
pub struct TileBounds {
    /// Western longitude (degrees)
    pub west: f64,
    /// Southern latitude (degrees)
    pub south: f64,
    /// Eastern longitude (degrees)
    pub east: f64,
    /// Northern latitude (degrees)
    pub north: f64,
}

impl TileBounds {
    /// Create new tile bounds.
    pub fn new(west: f64, south: f64, east: f64, north: f64) -> Self {
        Self {
            west,
            south,
            east,
            north,
        }
    }

    /// Width in degrees.
    pub fn width(&self) -> f64 {
        self.east - self.west
    }

    /// Height in degrees.
    pub fn height(&self) -> f64 {
        self.north - self.south
    }

    /// Center longitude.
    pub fn center_lon(&self) -> f64 {
        (self.west + self.east) / 2.0
    }

    /// Center latitude.
    pub fn center_lat(&self) -> f64 {
        (self.south + self.north) / 2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_quantized_vertices() {
        let mut vertices = QuantizedVertices::new();
        assert!(vertices.is_empty());

        vertices.push(0, 0, 100);
        vertices.push(QUANTIZED_MAX, QUANTIZED_MAX, 200);

        assert_eq!(vertices.len(), 2);
        assert_eq!(vertices.u, vec![0, QUANTIZED_MAX]);
        assert_eq!(vertices.v, vec![0, QUANTIZED_MAX]);
        assert_eq!(vertices.height, vec![100, 200]);
    }

    #[test]
    fn test_edge_indices_extraction() {
        // Create a simple 4-vertex grid
        let vertices = QuantizedVertices {
            u: vec![0, QUANTIZED_MAX, 0, QUANTIZED_MAX],
            v: vec![0, 0, QUANTIZED_MAX, QUANTIZED_MAX],
            height: vec![0, 0, 0, 0],
        };

        let edges = EdgeIndices::from_vertices(&vertices);

        // West edge: vertices 0, 2 (sorted by v)
        assert_eq!(edges.west, vec![0, 2]);
        // East edge: vertices 1, 3 (sorted by v)
        assert_eq!(edges.east, vec![1, 3]);
        // South edge: vertices 0, 1 (sorted by u)
        assert_eq!(edges.south, vec![0, 1]);
        // North edge: vertices 2, 3 (sorted by u)
        assert_eq!(edges.north, vec![2, 3]);
    }

    #[test]
    fn test_tile_bounds() {
        let bounds = TileBounds::new(-180.0, -90.0, 180.0, 90.0);

        assert_eq!(bounds.width(), 360.0);
        assert_eq!(bounds.height(), 180.0);
        assert_eq!(bounds.center_lon(), 0.0);
        assert_eq!(bounds.center_lat(), 0.0);
    }
}
