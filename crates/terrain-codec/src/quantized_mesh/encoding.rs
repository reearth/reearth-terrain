//! Encoding functions and main encoder for quantized-mesh format.

use std::io::Write;

use flate2::Compression;
use flate2::write::GzEncoder;

use super::{
    EdgeIndices, ExtensionId, QuantizedMeshHeader, QuantizedVertices, TileMetadata, WaterMask,
};

/// Encode a value using zig-zag encoding.
///
/// Maps signed integers to unsigned integers so that small magnitude values
/// (positive or negative) have small encoded values.
///
/// ```text
/// 0 -> 0, -1 -> 1, 1 -> 2, -2 -> 3, 2 -> 4, ...
/// ```
#[inline]
pub fn zigzag_encode(value: i32) -> u32 {
    ((value << 1) ^ (value >> 31)) as u32
}

/// Decode a zig-zag encoded value.
#[inline]
pub fn zigzag_decode(value: u32) -> i32 {
    ((value >> 1) as i32) ^ (-((value & 1) as i32))
}

/// Encode vertex coordinates using zig-zag delta encoding.
///
/// Each value is encoded as the zig-zag encoded difference from the previous value.
pub fn encode_zigzag_delta(values: &[u16]) -> Vec<u16> {
    let mut result = Vec::with_capacity(values.len());
    let mut prev = 0i32;

    for &value in values {
        let current = value as i32;
        let delta = current - prev;
        result.push(zigzag_encode(delta) as u16);
        prev = current;
    }

    result
}

/// Decode zig-zag delta encoded values.
pub fn decode_zigzag_delta(encoded: &[u16]) -> Vec<u16> {
    let mut result = Vec::with_capacity(encoded.len());
    let mut value = 0i32;

    for &enc in encoded {
        let delta = zigzag_decode(enc as u32);
        value += delta;
        result.push(value as u16);
    }

    result
}

/// Encode indices using high-water mark encoding.
///
/// This encoding is efficient when indices reference recently added vertices.
pub fn encode_high_water_mark(indices: &[u32]) -> Vec<u32> {
    let mut result = Vec::with_capacity(indices.len());
    let mut highest = 0u32;

    for &index in indices {
        let code = if index == highest {
            highest += 1;
            0
        } else {
            highest - index
        };
        result.push(code);
    }

    result
}

/// Decode high-water mark encoded indices.
pub fn decode_high_water_mark(encoded: &[u32]) -> Vec<u32> {
    let mut result = Vec::with_capacity(encoded.len());
    let mut highest = 0u32;

    for &code in encoded {
        let index = highest - code;
        if code == 0 {
            highest += 1;
        }
        result.push(index);
    }

    result
}

/// Oct-encode a unit normal vector to 2 bytes.
///
/// Uses octahedron encoding for efficient normal compression.
pub fn oct_encode_normal(normal: [f32; 3]) -> [u8; 2] {
    let [mut x, mut y, z] = normal;

    // Project to octahedron
    let inv_l1 = 1.0 / (x.abs() + y.abs() + z.abs());
    x *= inv_l1;
    y *= inv_l1;

    // Unfold lower hemisphere
    if z < 0.0 {
        let ox = x;
        x = (1.0 - y.abs()) * if ox >= 0.0 { 1.0 } else { -1.0 };
        y = (1.0 - ox.abs()) * if y >= 0.0 { 1.0 } else { -1.0 };
    }

    // Map from [-1, 1] to [0, 255]
    let encode = |v: f32| -> u8 { ((v * 0.5 + 0.5) * 255.0).clamp(0.0, 255.0) as u8 };

    [encode(x), encode(y)]
}

/// Options for encoding quantized mesh.
#[derive(Debug, Clone, Default)]
pub struct EncodeOptions {
    /// Include oct-encoded vertex normals
    pub include_normals: bool,
    /// Vertex normals (required if include_normals is true)
    pub normals: Option<Vec<[f32; 3]>>,
    /// Include water mask
    pub include_water_mask: bool,
    /// Water mask data
    pub water_mask: Option<WaterMask>,
    /// Include metadata extension with tile availability
    pub include_metadata: bool,
    /// Metadata for tile availability
    pub metadata: Option<TileMetadata>,
    /// Gzip compression level (0-9, default 6)
    pub compression_level: u32,
}

/// Quantized mesh encoder.
///
/// Encodes terrain mesh data into the quantized-mesh-1.0 format.
pub struct QuantizedMeshEncoder {
    header: QuantizedMeshHeader,
    vertices: QuantizedVertices,
    indices: Vec<u32>,
    edge_indices: EdgeIndices,
}

impl QuantizedMeshEncoder {
    /// Create a new encoder with mesh data.
    pub fn new(
        header: QuantizedMeshHeader,
        vertices: QuantizedVertices,
        indices: Vec<u32>,
        edge_indices: EdgeIndices,
    ) -> Self {
        Self {
            header,
            vertices,
            indices,
            edge_indices,
        }
    }

    /// Encode to quantized-mesh format without compression.
    pub fn encode(&self) -> Vec<u8> {
        self.encode_with_options(&EncodeOptions::default())
    }

    /// Encode with options (extensions, compression).
    pub fn encode_with_options(&self, options: &EncodeOptions) -> Vec<u8> {
        let uncompressed = self.encode_uncompressed(options);

        if options.compression_level == 0 {
            return uncompressed;
        }

        // Gzip compress
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(options.compression_level));
        encoder
            .write_all(&uncompressed)
            .expect("Failed to write to gzip encoder");
        encoder.finish().expect("Failed to finish gzip encoding")
    }

    /// Encode without compression.
    fn encode_uncompressed(&self, options: &EncodeOptions) -> Vec<u8> {
        let vertex_count = self.vertices.len();
        let use_32bit = vertex_count > 65535;

        // Estimate size
        let index_size = if use_32bit { 4 } else { 2 };
        let estimated_size = 88 // header
            + 4 // vertex count
            + vertex_count * 6 // u, v, height (3 x u16)
            + 4 // padding (worst case)
            + 4 // triangle count
            + self.indices.len() * index_size
            + 4 * 4 // edge counts
            + (self.edge_indices.west.len() + self.edge_indices.south.len()
               + self.edge_indices.east.len() + self.edge_indices.north.len()) * index_size
            + if options.include_normals { 5 + vertex_count * 2 } else { 0 }
            + if options.include_water_mask { 6 } else { 0 }
            + if options.include_metadata { 1024 } else { 0 }; // rough estimate for metadata

        let mut data = Vec::with_capacity(estimated_size);

        // Write header (88 bytes)
        data.extend_from_slice(&self.header.to_bytes());

        // Write vertex count
        data.extend_from_slice(&(vertex_count as u32).to_le_bytes());

        // Write encoded vertex data
        let encoded_u = encode_zigzag_delta(&self.vertices.u);
        let encoded_v = encode_zigzag_delta(&self.vertices.v);
        let encoded_height = encode_zigzag_delta(&self.vertices.height);

        for &u in &encoded_u {
            data.extend_from_slice(&u.to_le_bytes());
        }
        for &v in &encoded_v {
            data.extend_from_slice(&v.to_le_bytes());
        }
        for &h in &encoded_height {
            data.extend_from_slice(&h.to_le_bytes());
        }

        // Padding for index alignment
        if use_32bit {
            // Align to 4 bytes
            while data.len() % 4 != 0 {
                data.push(0);
            }
        } else {
            // Align to 2 bytes (should already be aligned after u16 arrays)
            while data.len() % 2 != 0 {
                data.push(0);
            }
        }

        // Write triangle count
        let triangle_count = self.indices.len() / 3;
        data.extend_from_slice(&(triangle_count as u32).to_le_bytes());

        // Write encoded indices
        let encoded_indices = encode_high_water_mark(&self.indices);
        if use_32bit {
            for &idx in &encoded_indices {
                data.extend_from_slice(&idx.to_le_bytes());
            }
        } else {
            for &idx in &encoded_indices {
                data.extend_from_slice(&(idx as u16).to_le_bytes());
            }
        }

        // Write edge indices
        self.write_edge_indices(&mut data, &self.edge_indices.west, use_32bit);
        self.write_edge_indices(&mut data, &self.edge_indices.south, use_32bit);
        self.write_edge_indices(&mut data, &self.edge_indices.east, use_32bit);
        self.write_edge_indices(&mut data, &self.edge_indices.north, use_32bit);

        // Write extensions
        if options.include_normals
            && let Some(normals) = &options.normals
        {
            self.write_normals_extension(&mut data, normals);
        }

        if options.include_water_mask {
            let water_mask = options.water_mask.as_ref().cloned().unwrap_or_default();
            self.write_water_mask_extension(&mut data, &water_mask);
        }

        if options.include_metadata
            && let Some(metadata) = &options.metadata
        {
            self.write_metadata_extension(&mut data, metadata);
        }

        data
    }

    fn write_edge_indices(&self, data: &mut Vec<u8>, indices: &[u32], use_32bit: bool) {
        data.extend_from_slice(&(indices.len() as u32).to_le_bytes());
        if use_32bit {
            for &idx in indices {
                data.extend_from_slice(&idx.to_le_bytes());
            }
        } else {
            for &idx in indices {
                data.extend_from_slice(&(idx as u16).to_le_bytes());
            }
        }
    }

    fn write_normals_extension(&self, data: &mut Vec<u8>, normals: &[[f32; 3]]) {
        // Extension header
        data.push(ExtensionId::OctEncodedVertexNormals as u8);
        let length = (normals.len() * 2) as u32;
        data.extend_from_slice(&length.to_le_bytes());

        // Oct-encoded normals
        for &normal in normals {
            let encoded = oct_encode_normal(normal);
            data.extend_from_slice(&encoded);
        }
    }

    fn write_water_mask_extension(&self, data: &mut Vec<u8>, water_mask: &WaterMask) {
        data.push(ExtensionId::WaterMask as u8);

        match water_mask {
            WaterMask::Uniform(value) => {
                data.extend_from_slice(&1u32.to_le_bytes());
                data.push(*value);
            }
            WaterMask::Grid(grid) => {
                data.extend_from_slice(&(256 * 256u32).to_le_bytes());
                data.extend_from_slice(grid.as_ref());
            }
        }
    }

    fn write_metadata_extension(&self, data: &mut Vec<u8>, metadata: &TileMetadata) {
        // Serialize metadata to JSON
        let json = serde_json::to_string(metadata).expect("Failed to serialize metadata");
        let json_bytes = json.as_bytes();

        // Extension header
        data.push(ExtensionId::Metadata as u8);

        // Extension length (4 bytes for json length + actual json)
        let extension_length: u32 = 4 + json_bytes.len() as u32;
        data.extend_from_slice(&extension_length.to_le_bytes());

        // JSON length
        data.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());

        // JSON data
        data.extend_from_slice(json_bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_zigzag_encode() {
        assert_eq!(zigzag_encode(0), 0);
        assert_eq!(zigzag_encode(-1), 1);
        assert_eq!(zigzag_encode(1), 2);
        assert_eq!(zigzag_encode(-2), 3);
        assert_eq!(zigzag_encode(2), 4);
    }

    #[test]
    fn test_zigzag_roundtrip() {
        for i in -1000..1000 {
            assert_eq!(zigzag_decode(zigzag_encode(i)), i);
        }
    }

    #[test]
    fn test_zigzag_delta_roundtrip() {
        let values: Vec<u16> = vec![0, 100, 50, 200, 150, 32767, 0];
        let encoded = encode_zigzag_delta(&values);
        let decoded = decode_zigzag_delta(&encoded);
        assert_eq!(values, decoded);
    }

    #[test]
    fn test_high_water_mark_simple() {
        // Sequential indices
        let indices = vec![0, 1, 2, 3, 4, 5];
        let encoded = encode_high_water_mark(&indices);
        // All zeros because each index equals highest
        assert_eq!(encoded, vec![0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn test_high_water_mark_roundtrip() {
        let indices = vec![0, 1, 2, 1, 3, 2, 0, 4, 3];
        let encoded = encode_high_water_mark(&indices);
        let decoded = decode_high_water_mark(&encoded);
        assert_eq!(indices, decoded);
    }

    #[test]
    fn test_oct_encode_normal() {
        // Up vector
        let up = [0.0f32, 0.0, 1.0];
        let encoded = oct_encode_normal(up);
        // Should be near center (127, 127)
        assert!((encoded[0] as i32 - 127).abs() < 2);
        assert!((encoded[1] as i32 - 127).abs() < 2);

        // Down vector
        let down = [0.0f32, 0.0, -1.0];
        let encoded = oct_encode_normal(down);
        // Should be at corners
        assert!(encoded[0] == 0 || encoded[0] == 255);
    }

    #[test]
    fn test_encoder_basic() {
        let header = QuantizedMeshHeader::default();
        let vertices = QuantizedVertices {
            u: vec![0, 32767, 0, 32767],
            v: vec![0, 0, 32767, 32767],
            height: vec![0, 0, 0, 0],
        };
        let indices = vec![0, 1, 2, 1, 3, 2];
        let edge_indices = EdgeIndices::from_vertices(&vertices);

        let encoder = QuantizedMeshEncoder::new(header, vertices, indices, edge_indices);
        let data = encoder.encode_with_options(&EncodeOptions {
            compression_level: 0,
            ..Default::default()
        });

        // Should have at least header + some data
        assert!(data.len() > 88);

        // First 88 bytes should be header
        let parsed_header = QuantizedMeshHeader::from_bytes(&data).unwrap();
        assert_eq!(parsed_header.min_height, 0.0);
    }

    #[test]
    fn test_encoder_with_compression() {
        let header = QuantizedMeshHeader::default();
        let vertices = QuantizedVertices {
            u: vec![0, 32767, 0, 32767],
            v: vec![0, 0, 32767, 32767],
            height: vec![0, 0, 0, 0],
        };
        let indices = vec![0, 1, 2, 1, 3, 2];
        let edge_indices = EdgeIndices::from_vertices(&vertices);

        let encoder = QuantizedMeshEncoder::new(header, vertices, indices, edge_indices);

        let _uncompressed = encoder.encode_with_options(&EncodeOptions {
            compression_level: 0,
            ..Default::default()
        });

        let compressed = encoder.encode_with_options(&EncodeOptions {
            compression_level: 6,
            ..Default::default()
        });

        // Compressed should typically be smaller (or at least start with gzip magic)
        assert_eq!(&compressed[0..2], &[0x1f, 0x8b]); // gzip magic number
    }

    #[test]
    fn test_encoder_with_extensions() {
        let header = QuantizedMeshHeader::default();
        let vertices = QuantizedVertices {
            u: vec![0, 32767, 0, 32767],
            v: vec![0, 0, 32767, 32767],
            height: vec![0, 0, 0, 0],
        };
        let indices = vec![0, 1, 2, 1, 3, 2];
        let edge_indices = EdgeIndices::from_vertices(&vertices);

        let encoder = QuantizedMeshEncoder::new(header, vertices, indices, edge_indices);

        let normals = vec![[0.0, 0.0, 1.0]; 4];

        let data = encoder.encode_with_options(&EncodeOptions {
            compression_level: 0,
            include_normals: true,
            normals: Some(normals),
            include_water_mask: true,
            water_mask: Some(WaterMask::Uniform(0)),
            ..Default::default()
        });

        // Should be larger with extensions
        let without_ext = encoder.encode_with_options(&EncodeOptions {
            compression_level: 0,
            ..Default::default()
        });

        assert!(data.len() > without_ext.len());
    }
}
