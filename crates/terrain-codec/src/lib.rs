// Cesium quantized-mesh support modules, ported as-is from PLATEAU-VIEW/tile
// (which itself credits MIERUNE/stralift). These are pure-compute Rust with
// no I/O, so they fit cleanly under our wasm32 target.
//
// `dead_code` is allowed at module scope because the ports carry their
// full original APIs even though our WASM surface only uses a subset —
// keeping the rest available makes follow-up exports a one-line change.
#[allow(dead_code)]
mod martini;
#[allow(dead_code)]
mod mesh;
#[allow(dead_code)]
mod quantized_mesh;

use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPEncoder;
use image::{ExtendedColorType, GenericImageView, ImageEncoder, ImageReader};
use std::io::Cursor;
use wasm_bindgen::prelude::*;

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
///   (0 = all land, 255 = all water); 65536 bytes = 256x256 grid mask
///   (caller is responsible for classification, so it can do it against
///   the orthometric DEM regardless of the ellipsoid offset baked into
///   `elevations`).
/// * `halo_elevations` / `halo_cells` - when non-empty, normals are
///   computed from the DEM gradient on this halo-extended grid (size
///   `(65 + 2*halo_cells)²`) instead of from face-normal accumulation.
///   Adjacent tiles read the same halo samples at any shared physical
///   position, so the seam normals match and the shading discontinuity
///   at tile boundaries disappears. Empty slice / `halo_cells = 0`
///   falls back to the legacy face-normal path.
#[wasm_bindgen]
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
    halo_elevations: &[f64],
    halo_cells: u32,
) -> Vec<u8> {
    let bounds = mesh::MeshTileBounds::new(west, south, east, north);
    let (include_water_mask, water_mask_struct) = match water_mask.len() {
        0 => (false, None),
        1 => (true, Some(mesh::MeshWaterMask::Uniform(water_mask[0]))),
        len if len == 256 * 256 => (true, Some(mesh::MeshWaterMask::from_data(water_mask))),
        _ => (false, None), // ignore malformed input
    };
    let halo = if include_normals && halo_cells > 0 && !halo_elevations.is_empty() {
        let halo_side = mesh::MESH_GRID_SIZE as usize + 2 * halo_cells as usize;
        if halo_elevations.len() == halo_side * halo_side {
            Some(mesh::HaloElevations {
                elevations: halo_elevations.to_vec(),
                halo: halo_cells,
            })
        } else {
            None // malformed — fall back to face-normal path
        }
    } else {
        None
    };
    let opts = mesh::QuantizedMeshOptions {
        max_error,
        compression_level,
        include_normals,
        include_water_mask,
        water_mask: water_mask_struct,
        halo_elevations: halo,
        ..Default::default()
    };
    mesh::generate_quantized_mesh_tile(elevations, &bounds, &opts).data
}

// ---------- Encoding (elevation -> RGB) ----------

/// Encode elevation values (meters) as Terrarium-style RGB bytes:
///   `elevation = (R * 256 + G + B / 256) - 32768`
#[wasm_bindgen]
pub fn encode_terrarium(elevations: &[f32], width: u32, height: u32) -> Vec<u8> {
    let expected = (width as usize) * (height as usize);
    assert_eq!(elevations.len(), expected, "elevations length mismatch");

    let mut out = Vec::with_capacity(expected * 3);
    for &e in elevations {
        let v = (e + 32768.0) * 256.0;
        let v = v.clamp(0.0, (1u32 << 24) as f32 - 1.0) as u32;
        out.push(((v >> 16) & 0xff) as u8);
        out.push(((v >> 8) & 0xff) as u8);
        out.push((v & 0xff) as u8);
    }
    out
}

/// Encode elevation values as Mapbox Terrain-RGB:
///   `elevation = -10000 + (R * 256 * 256 + G * 256 + B) * 0.1`
#[wasm_bindgen]
pub fn encode_mapbox(elevations: &[f32], width: u32, height: u32) -> Vec<u8> {
    let expected = (width as usize) * (height as usize);
    assert_eq!(elevations.len(), expected, "elevations length mismatch");

    let mut out = Vec::with_capacity(expected * 3);
    for &e in elevations {
        let v = ((e + 10000.0) * 10.0).round();
        let v = v.clamp(0.0, (1u32 << 24) as f32 - 1.0) as u32;
        out.push(((v >> 16) & 0xff) as u8);
        out.push(((v >> 8) & 0xff) as u8);
        out.push((v & 0xff) as u8);
    }
    out
}

// ---------- Image container encoders (RGB -> WebP / PNG) ----------

#[wasm_bindgen]
pub fn rgb_to_webp(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsError> {
    encode_image(rgb, width, height, ImageContainer::WebP)
}

#[wasm_bindgen]
pub fn rgb_to_png(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsError> {
    encode_image(rgb, width, height, ImageContainer::Png)
}

enum ImageContainer {
    Png,
    WebP,
}

fn encode_image(
    rgb: &[u8],
    width: u32,
    height: u32,
    container: ImageContainer,
) -> Result<Vec<u8>, JsError> {
    let expected = (width as usize) * (height as usize) * 3;
    if rgb.len() != expected {
        return Err(JsError::new(&format!(
            "rgb length mismatch: got {}, expected {}",
            rgb.len(),
            expected
        )));
    }
    let mut out = Vec::with_capacity(expected / 3);
    match container {
        ImageContainer::Png => {
            PngEncoder::new(&mut out)
                .write_image(rgb, width, height, ExtendedColorType::Rgb8)
                .map_err(|e| JsError::new(&format!("png encode failed: {e}")))?;
        }
        ImageContainer::WebP => {
            // image-webp 0.2 emits lossless WebP from `WebPEncoder`. Good
            // enough for an MVP — lossy WebP would need an external codec.
            WebPEncoder::new_lossless(&mut out)
                .write_image(rgb, width, height, ExtendedColorType::Rgb8)
                .map_err(|e| JsError::new(&format!("webp encode failed: {e}")))?;
        }
    }
    Ok(out)
}

// ---------- Decoding (Terrarium WebP/PNG -> Float32 elevations) ----------

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
    decode_terrarium_image(bytes, image::ImageFormat::WebP)
}

#[wasm_bindgen]
pub fn decode_terrarium_png(bytes: &[u8]) -> Result<DecodedTile, JsError> {
    decode_terrarium_image(bytes, image::ImageFormat::Png)
}

fn decode_terrarium_image(
    bytes: &[u8],
    format: image::ImageFormat,
) -> Result<DecodedTile, JsError> {
    let mut reader = ImageReader::new(Cursor::new(bytes));
    reader.set_format(format);
    let img = reader
        .decode()
        .map_err(|e| JsError::new(&format!("image decode failed: {e}")))?;
    let (width, height) = img.dimensions();
    let rgba = img.into_rgba8();
    let mut elevations = Vec::with_capacity((width as usize) * (height as usize));
    for px in rgba.pixels() {
        let r = px.0[0] as f32;
        let g = px.0[1] as f32;
        let b = px.0[2] as f32;
        elevations.push(r * 256.0 + g + b / 256.0 - 32768.0);
    }
    Ok(DecodedTile {
        width,
        height,
        elevations,
    })
}
