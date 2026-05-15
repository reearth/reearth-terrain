//! Encoder for Cesium quantized-mesh-1.0 terrain format.
//!
//! Ported from stralift's `quantized-mesh` crate. See format specification:
//! <https://github.com/CesiumGS/quantized-mesh>

pub mod coords;
mod encoding;
mod header;
mod types;

pub use encoding::*;
pub use header::*;
pub use types::*;
