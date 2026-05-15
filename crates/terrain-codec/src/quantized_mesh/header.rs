//! Header structures for quantized-mesh format.

use super::TileBounds;
use super::coords::{
    WGS84_SEMI_MAJOR_AXIS, ecef_to_ellipsoid_scaled, geodetic_to_ecef, vec3_distance,
    vec3_magnitude, vec3_normalize,
};

/// Quantized mesh header (88 bytes).
///
/// All coordinates are in Earth-Centered Earth-Fixed (ECEF) frame.
#[derive(Debug, Clone, Copy)]
pub struct QuantizedMeshHeader {
    /// Center of the tile in ECEF coordinates (meters)
    pub center: [f64; 3],
    /// Minimum height in the tile (meters)
    pub min_height: f32,
    /// Maximum height in the tile (meters)
    pub max_height: f32,
    /// Bounding sphere center in ECEF coordinates (meters)
    pub bounding_sphere_center: [f64; 3],
    /// Bounding sphere radius (meters)
    pub bounding_sphere_radius: f64,
    /// Horizon occlusion point in ellipsoid-scaled ECEF coordinates
    pub horizon_occlusion_point: [f64; 3],
}

impl Default for QuantizedMeshHeader {
    fn default() -> Self {
        Self {
            center: [0.0, 0.0, WGS84_SEMI_MAJOR_AXIS],
            min_height: 0.0,
            max_height: 0.0,
            bounding_sphere_center: [0.0, 0.0, WGS84_SEMI_MAJOR_AXIS],
            bounding_sphere_radius: 0.0,
            horizon_occlusion_point: [0.0, 0.0, 1.0],
        }
    }
}

impl QuantizedMeshHeader {
    /// Create a header from tile bounds and height range.
    ///
    /// Computes ECEF coordinates, bounding sphere, and horizon occlusion point.
    /// Falls back to corner+edge sample points for the horizon occlusion — callers
    /// that have the actual mesh vertices should prefer `from_bounds_with_vertices`
    /// for tighter occlusion.
    pub fn from_bounds(bounds: &TileBounds, min_height: f32, max_height: f32) -> Self {
        Self::from_bounds_with_vertices(bounds, min_height, max_height, &[])
    }

    /// Like `from_bounds`, but uses the supplied mesh vertices (geodetic
    /// `(lon, lat, height)`) to compute a tighter horizon occlusion point via
    /// the Cesium `EllipsoidalOccluder` algorithm.
    pub fn from_bounds_with_vertices(
        bounds: &TileBounds,
        min_height: f32,
        max_height: f32,
        vertices_geodetic: &[(f64, f64, f64)],
    ) -> Self {
        let center_lon = bounds.center_lon();
        let center_lat = bounds.center_lat();
        let center_height = (min_height as f64 + max_height as f64) / 2.0;

        let center = geodetic_to_ecef(center_lon, center_lat, center_height);

        let (bounding_sphere_center, bounding_sphere_radius) =
            compute_bounding_sphere(bounds, min_height as f64, max_height as f64);

        let horizon_occlusion_point = compute_horizon_occlusion_point(
            &bounding_sphere_center,
            bounds,
            min_height as f64,
            max_height as f64,
            vertices_geodetic,
        );

        Self {
            center,
            min_height,
            max_height,
            bounding_sphere_center,
            bounding_sphere_radius,
            horizon_occlusion_point,
        }
    }

    /// Serialize header to bytes (88 bytes, little-endian).
    pub fn to_bytes(&self) -> [u8; 88] {
        let mut bytes = [0u8; 88];
        let mut offset = 0;

        // Center (3 x f64 = 24 bytes)
        for &v in &self.center {
            bytes[offset..offset + 8].copy_from_slice(&v.to_le_bytes());
            offset += 8;
        }

        // Min/Max height (2 x f32 = 8 bytes)
        bytes[offset..offset + 4].copy_from_slice(&self.min_height.to_le_bytes());
        offset += 4;
        bytes[offset..offset + 4].copy_from_slice(&self.max_height.to_le_bytes());
        offset += 4;

        // Bounding sphere center (3 x f64 = 24 bytes)
        for &v in &self.bounding_sphere_center {
            bytes[offset..offset + 8].copy_from_slice(&v.to_le_bytes());
            offset += 8;
        }

        // Bounding sphere radius (f64 = 8 bytes)
        bytes[offset..offset + 8].copy_from_slice(&self.bounding_sphere_radius.to_le_bytes());
        offset += 8;

        // Horizon occlusion point (3 x f64 = 24 bytes)
        for &v in &self.horizon_occlusion_point {
            bytes[offset..offset + 8].copy_from_slice(&v.to_le_bytes());
            offset += 8;
        }

        debug_assert_eq!(offset, 88);
        bytes
    }

    /// Deserialize header from bytes.
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 88 {
            return None;
        }

        let mut offset = 0;

        let read_f64 = |bytes: &[u8], offset: &mut usize| -> f64 {
            let v = f64::from_le_bytes(bytes[*offset..*offset + 8].try_into().unwrap());
            *offset += 8;
            v
        };

        let read_f32 = |bytes: &[u8], offset: &mut usize| -> f32 {
            let v = f32::from_le_bytes(bytes[*offset..*offset + 4].try_into().unwrap());
            *offset += 4;
            v
        };

        let center = [
            read_f64(bytes, &mut offset),
            read_f64(bytes, &mut offset),
            read_f64(bytes, &mut offset),
        ];

        let min_height = read_f32(bytes, &mut offset);
        let max_height = read_f32(bytes, &mut offset);

        let bounding_sphere_center = [
            read_f64(bytes, &mut offset),
            read_f64(bytes, &mut offset),
            read_f64(bytes, &mut offset),
        ];

        let bounding_sphere_radius = read_f64(bytes, &mut offset);

        let horizon_occlusion_point = [
            read_f64(bytes, &mut offset),
            read_f64(bytes, &mut offset),
            read_f64(bytes, &mut offset),
        ];

        Some(Self {
            center,
            min_height,
            max_height,
            bounding_sphere_center,
            bounding_sphere_radius,
            horizon_occlusion_point,
        })
    }
}

/// Compute bounding sphere for a tile.
///
/// Returns (center, radius) in ECEF coordinates.
///
/// The center is the geographic center of the tile at the average height,
/// and the radius is the maximum distance from this center to any corner.
fn compute_bounding_sphere(
    bounds: &TileBounds,
    min_height: f64,
    max_height: f64,
) -> ([f64; 3], f64) {
    // Use the geographic center of the tile at average height as the bounding sphere center
    // This gives a tighter bounding sphere than using the centroid of corner points,
    // especially for large tiles like level 0 which span half the globe.
    let avg_height = (min_height + max_height) / 2.0;
    let center = geodetic_to_ecef(bounds.center_lon(), bounds.center_lat(), avg_height);

    // Sample corner and edge points at both height extremes
    let points = [
        // Corners at min height
        geodetic_to_ecef(bounds.west, bounds.south, min_height),
        geodetic_to_ecef(bounds.east, bounds.south, min_height),
        geodetic_to_ecef(bounds.west, bounds.north, min_height),
        geodetic_to_ecef(bounds.east, bounds.north, min_height),
        // Corners at max height
        geodetic_to_ecef(bounds.west, bounds.south, max_height),
        geodetic_to_ecef(bounds.east, bounds.south, max_height),
        geodetic_to_ecef(bounds.west, bounds.north, max_height),
        geodetic_to_ecef(bounds.east, bounds.north, max_height),
        // Edge midpoints at max height (important for large tiles)
        geodetic_to_ecef(bounds.west, bounds.center_lat(), max_height),
        geodetic_to_ecef(bounds.east, bounds.center_lat(), max_height),
        geodetic_to_ecef(bounds.center_lon(), bounds.south, max_height),
        geodetic_to_ecef(bounds.center_lon(), bounds.north, max_height),
    ];

    // Compute radius as max distance from center to any sampled point
    let mut radius = 0.0f64;
    for p in &points {
        let dist = vec3_distance(&center, p);
        radius = radius.max(dist);
    }

    (center, radius)
}

/// Compute horizon occlusion point in ellipsoid-scaled coordinates, using the
/// Cesium `EllipsoidalOccluder` algorithm.
///
/// The point lies along the bounding-sphere-center direction (in scaled space).
/// Its magnitude is the max, over every sample point on or above the tile, of
/// the "tangent-from-horizon" magnitude that keeps that sample on the
/// camera-side of the horizon plane. For tiles big enough that some sample is
/// orthogonal (or beyond) the direction (e.g. a level-0 hemisphere), the
/// magnitude diverges — matching Cesium World Terrain's huge level-0
/// occlusion points and ensuring those tiles are never falsely culled.
fn compute_horizon_occlusion_point(
    bounding_sphere_center: &[f64; 3],
    bounds: &TileBounds,
    min_height: f64,
    max_height: f64,
    vertices_geodetic: &[(f64, f64, f64)],
) -> [f64; 3] {
    let scaled_center = ecef_to_ellipsoid_scaled(bounding_sphere_center);
    let dir_mag = vec3_magnitude(&scaled_center);
    if dir_mag < 1e-10 {
        // Degenerate (sphere center near origin) — Cesium uses the +Z pole as a
        // safe default. The visibility test will fall back to frustum culling.
        return [0.0, 0.0, 1.0];
    }
    let direction = vec3_normalize(&scaled_center);

    // Cesium's algorithm needs sample points that fully bracket the tile. The
    // mesh vertices are the tightest source; fall back to corners + edge
    // midpoints (matching what `compute_bounding_sphere` uses) when none are
    // supplied — that keeps `from_bounds()` standalone-correct for tests.
    let mut max_magnitude: f64 = 0.0;
    let mut update = |position: [f64; 3]| {
        if let Some(m) = compute_occlusion_magnitude(&position, &direction) {
            if m > max_magnitude {
                max_magnitude = m;
            }
        }
    };

    if vertices_geodetic.is_empty() {
        let avg_h = (min_height + max_height) / 2.0;
        let cx = bounds.center_lon();
        let cy = bounds.center_lat();
        for &h in &[min_height, max_height] {
            update(geodetic_to_ecef(bounds.west, bounds.south, h));
            update(geodetic_to_ecef(bounds.east, bounds.south, h));
            update(geodetic_to_ecef(bounds.west, bounds.north, h));
            update(geodetic_to_ecef(bounds.east, bounds.north, h));
        }
        update(geodetic_to_ecef(bounds.west, cy, avg_h));
        update(geodetic_to_ecef(bounds.east, cy, avg_h));
        update(geodetic_to_ecef(cx, bounds.south, avg_h));
        update(geodetic_to_ecef(cx, bounds.north, avg_h));
        update(geodetic_to_ecef(cx, cy, max_height));
    } else {
        for &(lon, lat, h) in vertices_geodetic {
            update(geodetic_to_ecef(lon, lat, h));
        }
    }

    if !max_magnitude.is_finite() || max_magnitude <= 0.0 {
        // Couldn't compute a usable magnitude for any sample — give the
        // tile a unit-sphere occluder so cameras over it stay visible.
        max_magnitude = 1.0;
    }

    [
        direction[0] * max_magnitude,
        direction[1] * max_magnitude,
        direction[2] * max_magnitude,
    ]
}

/// Per-vertex magnitude from Cesium's `EllipsoidalOccluder.computeMagnitude`.
///
/// Returns the magnitude (along `direction`, normalized in scaled space) at
/// which the horizon-occlusion point must sit for `position` to stay on the
/// camera-side of the horizon plane. Returns `None` when the formula is
/// numerically unusable (denominator <= 0) — callers should treat that the
/// same as an infinite magnitude (the sample is "off-axis" enough that no
/// finite occluder can shadow it).
fn compute_occlusion_magnitude(position: &[f64; 3], direction: &[f64; 3]) -> Option<f64> {
    let scaled = ecef_to_ellipsoid_scaled(position);
    // Clamp magnitude to >= 1 so vertices that dip slightly below the
    // ellipsoid (e.g. minimum-height samples near the geoid) still produce a
    // valid candidate — Cesium's "PossiblyUnderEllipsoid" variant does this.
    let mag_sq = (scaled[0] * scaled[0] + scaled[1] * scaled[1] + scaled[2] * scaled[2]).max(1.0);
    let mag = mag_sq.sqrt();
    let inv_mag = 1.0 / mag;
    let unit = [scaled[0] * inv_mag, scaled[1] * inv_mag, scaled[2] * inv_mag];

    let cos_alpha = unit[0] * direction[0] + unit[1] * direction[1] + unit[2] * direction[2];
    // sin_alpha = |unit × direction|
    let cx = unit[1] * direction[2] - unit[2] * direction[1];
    let cy = unit[2] * direction[0] - unit[0] * direction[2];
    let cz = unit[0] * direction[1] - unit[1] * direction[0];
    let sin_alpha = (cx * cx + cy * cy + cz * cz).sqrt();
    let cos_beta = inv_mag;
    let sin_beta = (mag_sq - 1.0).max(0.0).sqrt() * inv_mag;

    let denom = cos_alpha * cos_beta - sin_alpha * sin_beta;
    if denom <= 0.0 {
        None
    } else {
        Some(1.0 / denom)
    }
}

#[cfg(test)]
mod tests {
    use super::super::coords::WGS84_SEMI_MINOR_AXIS;
    use super::*;

    #[test]
    fn test_header_serialization_roundtrip() {
        let header = QuantizedMeshHeader {
            center: [1.0, 2.0, 3.0],
            min_height: 100.0,
            max_height: 200.0,
            bounding_sphere_center: [4.0, 5.0, 6.0],
            bounding_sphere_radius: 1000.0,
            horizon_occlusion_point: [0.1, 0.2, 0.3],
        };

        let bytes = header.to_bytes();
        assert_eq!(bytes.len(), 88);

        let parsed = QuantizedMeshHeader::from_bytes(&bytes).unwrap();

        assert_eq!(header.center, parsed.center);
        assert_eq!(header.min_height, parsed.min_height);
        assert_eq!(header.max_height, parsed.max_height);
        assert_eq!(header.bounding_sphere_center, parsed.bounding_sphere_center);
        assert_eq!(header.bounding_sphere_radius, parsed.bounding_sphere_radius);
        assert_eq!(
            header.horizon_occlusion_point,
            parsed.horizon_occlusion_point
        );
    }

    #[test]
    fn test_header_from_bounds() {
        let bounds = TileBounds::new(-1.0, -1.0, 1.0, 1.0);
        let header = QuantizedMeshHeader::from_bounds(&bounds, 0.0, 100.0);

        // Center should be near equator/prime meridian
        assert!(header.center[0] > 0.0); // X should be positive (facing prime meridian)
        assert!(header.center[1].abs() < 1000.0); // Y should be near zero
        assert!(header.center[2].abs() < 1000.0); // Z should be near zero

        assert_eq!(header.min_height, 0.0);
        assert_eq!(header.max_height, 100.0);
        assert!(header.bounding_sphere_radius > 0.0);
    }

    #[test]
    fn test_header_default() {
        let header = QuantizedMeshHeader::default();

        assert_eq!(header.center[0], 0.0);
        assert_eq!(header.center[1], 0.0);
        assert!((header.center[2] - WGS84_SEMI_MAJOR_AXIS).abs() < 1.0);
    }

    /// Regression: the level-0 eastern-hemisphere tile must produce a horizon
    /// occlusion point that keeps cameras anywhere over the eastern hemisphere
    /// from being culled. Pre-fix, the magnitude was ~2.4 along +Y, which
    /// false-culled cameras with small ECEF Y (Geneva, Amsterdam, …) because
    /// Cesium's `isScaledSpacePointVisible` test marked the tile as below
    /// horizon. The fix uses Cesium's per-vertex algorithm; for hemisphere
    /// tiles its formula diverges (matching Cesium World Terrain's huge level-0
    /// occlusion magnitudes).
    #[test]
    fn test_horizon_occlusion_visible_for_low_longitude_cameras() {
        use super::super::coords::{WGS84_SEMI_MAJOR_AXIS as A, ecef_to_ellipsoid_scaled};

        // Level-0 east tile: lon 0..180, lat -90..90.
        let bounds = TileBounds::new(0.0, -90.0, 180.0, 90.0);
        let header = QuantizedMeshHeader::from_bounds(&bounds, -100.0, 6000.0);
        let p = header.horizon_occlusion_point;

        // Cesium visibility test: visible iff `vtDotVc <= dt2`, or the
        // "isOccluded" follow-up fails. For cameras over the eastern
        // hemisphere we need `P · V > V · V` (condition 1 trivially true with
        // negative vtDotVc).
        let camera_ecef = geodetic_to_ecef(6.5, 46.4, 5000.0); // Geneva, 5km up
        let v = ecef_to_ellipsoid_scaled(&camera_ecef);
        let v_dot_v = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
        let p_dot_v = p[0] * v[0] + p[1] * v[1] + p[2] * v[2];
        let vt_dot_vc = v_dot_v - p_dot_v;
        let dt2 = v_dot_v - 1.0;
        assert!(
            vt_dot_vc <= dt2,
            "Geneva camera should pass condition-1 visibility for level-0 east tile; vtDotVc={vt_dot_vc} dt2={dt2}"
        );

        // Antipodal camera (mid-Pacific) must still be culled — otherwise
        // we'd be over-rendering. Verify either condition 1 fails OR the
        // isOccluded check succeeds.
        let antipode_ecef = geodetic_to_ecef(-100.0, -30.0, 5000.0);
        let v = ecef_to_ellipsoid_scaled(&antipode_ecef);
        let v_dot_v = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
        let p_dot_v = p[0] * v[0] + p[1] * v[1] + p[2] * v[2];
        let vt_dot_vc = v_dot_v - p_dot_v;
        let dt2 = v_dot_v - 1.0;
        let visible = if vt_dot_vc <= dt2 {
            true
        } else {
            let vt_minus_p = [p[0] - v[0], p[1] - v[1], p[2] - v[2]];
            let lensq = vt_minus_p[0] * vt_minus_p[0]
                + vt_minus_p[1] * vt_minus_p[1]
                + vt_minus_p[2] * vt_minus_p[2];
            !((vt_dot_vc * vt_dot_vc) / lensq >= dt2)
        };
        assert!(
            !visible,
            "Antipodal camera over Pacific must be culled by level-0 east tile occluder"
        );

        // Reference WGS84_SEMI_MAJOR_AXIS to keep the import path honest.
        let _ = A;
    }

    #[test]
    fn test_bounding_sphere_at_pole() {
        let bounds = TileBounds::new(-10.0, 80.0, 10.0, 90.0);
        let header = QuantizedMeshHeader::from_bounds(&bounds, 0.0, 1000.0);

        // Near north pole, Z should be close to semi-minor axis
        assert!(header.center[2] > WGS84_SEMI_MINOR_AXIS * 0.9);
        assert!(header.bounding_sphere_radius > 0.0);
    }
}
