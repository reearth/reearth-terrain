//! Coordinate transformations and geodetic constants.

use std::f64::consts::PI;

/// WGS84 ellipsoid semi-major axis (equatorial radius) in meters.
pub const WGS84_SEMI_MAJOR_AXIS: f64 = 6_378_137.0;

/// WGS84 ellipsoid semi-minor axis (polar radius) in meters.
pub const WGS84_SEMI_MINOR_AXIS: f64 = 6_356_752.314_245;

/// WGS84 ellipsoid flattening.
pub const WGS84_FLATTENING: f64 = 1.0 / 298.257_223_563;

/// WGS84 first eccentricity squared.
pub const WGS84_E2: f64 = 2.0 * WGS84_FLATTENING - WGS84_FLATTENING * WGS84_FLATTENING;

/// Convert degrees to radians.
#[inline]
pub fn deg_to_rad(deg: f64) -> f64 {
    deg * PI / 180.0
}

/// Convert radians to degrees.
#[inline]
pub fn rad_to_deg(rad: f64) -> f64 {
    rad * 180.0 / PI
}

/// Convert geodetic coordinates (degrees, meters) to ECEF (meters).
///
/// ECEF (Earth-Centered Earth-Fixed) is a Cartesian coordinate system
/// with origin at Earth's center of mass.
///
/// # Arguments
///
/// * `lon_deg` - Longitude in degrees (-180 to 180)
/// * `lat_deg` - Latitude in degrees (-90 to 90)
/// * `height` - Height above ellipsoid in meters
///
/// # Returns
///
/// [X, Y, Z] coordinates in meters where:
/// - X axis points to 0° longitude, 0° latitude
/// - Y axis points to 90° longitude, 0° latitude
/// - Z axis points to North Pole
pub fn geodetic_to_ecef(lon_deg: f64, lat_deg: f64, height: f64) -> [f64; 3] {
    let lon = deg_to_rad(lon_deg);
    let lat = deg_to_rad(lat_deg);

    let sin_lat = lat.sin();
    let cos_lat = lat.cos();
    let sin_lon = lon.sin();
    let cos_lon = lon.cos();

    // Radius of curvature in the prime vertical
    let n = WGS84_SEMI_MAJOR_AXIS / (1.0 - WGS84_E2 * sin_lat * sin_lat).sqrt();

    let x = (n + height) * cos_lat * cos_lon;
    let y = (n + height) * cos_lat * sin_lon;
    let z = (n * (1.0 - WGS84_E2) + height) * sin_lat;

    [x, y, z]
}

/// Convert ECEF coordinates (meters) to geodetic (degrees, meters).
///
/// Uses iterative method for accurate results.
///
/// # Arguments
///
/// * `x` - X coordinate in meters
/// * `y` - Y coordinate in meters
/// * `z` - Z coordinate in meters
///
/// # Returns
///
/// (longitude, latitude, height) where longitude and latitude are in degrees.
pub fn ecef_to_geodetic(x: f64, y: f64, z: f64) -> (f64, f64, f64) {
    let lon = y.atan2(x);

    let p = (x * x + y * y).sqrt();
    let mut lat = (z / p).atan(); // Initial approximation

    // Iterative refinement (Bowring's method)
    for _ in 0..5 {
        let sin_lat = lat.sin();
        let n = WGS84_SEMI_MAJOR_AXIS / (1.0 - WGS84_E2 * sin_lat * sin_lat).sqrt();
        lat = (z + WGS84_E2 * n * sin_lat).atan2(p);
    }

    let sin_lat = lat.sin();
    let cos_lat = lat.cos();
    let n = WGS84_SEMI_MAJOR_AXIS / (1.0 - WGS84_E2 * sin_lat * sin_lat).sqrt();

    let height = if cos_lat.abs() > 1e-10 {
        p / cos_lat - n
    } else {
        z.abs() / sin_lat.abs() - n * (1.0 - WGS84_E2)
    };

    (rad_to_deg(lon), rad_to_deg(lat), height)
}

/// Scale ECEF coordinates to unit ellipsoid.
///
/// This is used for horizon occlusion calculations.
#[inline]
pub fn ecef_to_ellipsoid_scaled(ecef: &[f64; 3]) -> [f64; 3] {
    [
        ecef[0] / WGS84_SEMI_MAJOR_AXIS,
        ecef[1] / WGS84_SEMI_MAJOR_AXIS,
        ecef[2] / WGS84_SEMI_MINOR_AXIS,
    ]
}

/// Compute the magnitude (length) of a 3D vector.
#[inline]
pub fn vec3_magnitude(v: &[f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

/// Normalize a 3D vector.
#[inline]
pub fn vec3_normalize(v: &[f64; 3]) -> [f64; 3] {
    let mag = vec3_magnitude(v);
    if mag < 1e-10 {
        return [0.0, 0.0, 1.0];
    }
    [v[0] / mag, v[1] / mag, v[2] / mag]
}

/// Compute distance between two 3D points.
#[inline]
pub fn vec3_distance(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    (dx * dx + dy * dy + dz * dz).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPSILON: f64 = 1.0;

    #[test]
    fn test_deg_rad_conversion() {
        assert!((deg_to_rad(180.0) - PI).abs() < 1e-10);
        assert!((rad_to_deg(PI) - 180.0).abs() < 1e-10);
        assert!((deg_to_rad(90.0) - PI / 2.0).abs() < 1e-10);
    }

    #[test]
    fn test_geodetic_to_ecef_equator() {
        let [x, y, z] = geodetic_to_ecef(0.0, 0.0, 0.0);

        assert!((x - WGS84_SEMI_MAJOR_AXIS).abs() < EPSILON);
        assert!(y.abs() < EPSILON);
        assert!(z.abs() < EPSILON);
    }

    #[test]
    fn test_geodetic_to_ecef_north_pole() {
        let [x, y, z] = geodetic_to_ecef(0.0, 90.0, 0.0);

        assert!(x.abs() < EPSILON);
        assert!(y.abs() < EPSILON);
        assert!((z - WGS84_SEMI_MINOR_AXIS).abs() < EPSILON);
    }

    #[test]
    fn test_geodetic_to_ecef_90_longitude() {
        let [x, y, z] = geodetic_to_ecef(90.0, 0.0, 0.0);

        assert!(x.abs() < EPSILON);
        assert!((y - WGS84_SEMI_MAJOR_AXIS).abs() < EPSILON);
        assert!(z.abs() < EPSILON);
    }

    #[test]
    fn test_geodetic_to_ecef_with_height() {
        let height = 1000.0;
        let [x, _y, _z] = geodetic_to_ecef(0.0, 0.0, height);

        assert!((x - (WGS84_SEMI_MAJOR_AXIS + height)).abs() < EPSILON);
    }

    #[test]
    fn test_ecef_geodetic_roundtrip() {
        let test_cases = [
            (0.0, 0.0, 0.0),
            (90.0, 0.0, 0.0),
            (-90.0, 0.0, 0.0),
            (0.0, 45.0, 0.0),
            (0.0, -45.0, 0.0),
            (139.7, 35.7, 100.0), // Tokyo
            (-122.4, 37.8, 50.0), // San Francisco
        ];

        for (lon, lat, h) in test_cases {
            let ecef = geodetic_to_ecef(lon, lat, h);
            let (lon2, lat2, h2) = ecef_to_geodetic(ecef[0], ecef[1], ecef[2]);

            assert!(
                (lon - lon2).abs() < 1e-6,
                "Longitude mismatch: {lon} vs {lon2}"
            );
            assert!(
                (lat - lat2).abs() < 1e-6,
                "Latitude mismatch: {lat} vs {lat2}"
            );
            assert!((h - h2).abs() < 1e-3, "Height mismatch: {h} vs {h2}");
        }
    }

    #[test]
    fn test_ellipsoid_scaled() {
        let ecef = [WGS84_SEMI_MAJOR_AXIS, 0.0, 0.0];
        let scaled = ecef_to_ellipsoid_scaled(&ecef);

        assert!((scaled[0] - 1.0).abs() < 1e-10);
        assert!(scaled[1].abs() < 1e-10);
        assert!(scaled[2].abs() < 1e-10);
    }

    #[test]
    fn test_vec3_operations() {
        let v = [3.0, 4.0, 0.0];
        assert!((vec3_magnitude(&v) - 5.0).abs() < 1e-10);

        let n = vec3_normalize(&v);
        assert!((n[0] - 0.6).abs() < 1e-10);
        assert!((n[1] - 0.8).abs() < 1e-10);
        assert!(n[2].abs() < 1e-10);

        let a = [0.0, 0.0, 0.0];
        let b = [3.0, 4.0, 0.0];
        assert!((vec3_distance(&a, &b) - 5.0).abs() < 1e-10);
    }
}
