//! RTIN mesh generation for terrain data based on the Martini algorithm.
//!
//! This crate implements the RTIN (Right-Triangulated Irregular Network) mesh generation
//! algorithm, which creates level-of-detail terrain meshes from heightmap data.
//!
//! # References
//!
//! - Original JavaScript implementation: <https://github.com/mapbox/martini>
//! - Paper: "Right-Triangulated Irregular Networks" by Will Evans et al.
//!
//! # Example
//!
//! ```ignore
//! use martini::Martini;
//!
//! // Create a Martini instance for a 257x257 grid (2^8 + 1)
//! let mut martini = Martini::new(257);
//!
//! // Create terrain from height data
//! let terrain = vec![0.0f64; 257 * 257];
//! let tile = martini.create_terrain(|x, y| terrain[y * 257 + x]);
//!
//! // Generate mesh with maximum error threshold
//! let (vertices, indices, uvs) = tile.construct_mesh(&mut martini, 10.0, &mut |(u, v)| {
//!     (u, v, 0.0)
//! });
//! ```

/// Float type used for height values and error calculations.
pub type FloatType = f64;

/// Martini terrain mesh generator.
///
/// Pre-computes triangle coordinates for a given grid size to enable
/// efficient mesh generation from heightmap data.
pub struct Martini {
    /// Grid size (must be 2^n + 1)
    pub size: u32,
    num_triangles: u32,
    num_parent_triangles: u32,
    /// Pre-computed triangle coordinates
    pub coords: Vec<u32>,
    index_map: Vec<Option<usize>>,
}

impl Martini {
    /// Create a new Martini instance for a grid of the given size.
    ///
    /// # Arguments
    ///
    /// * `size` - Grid size, must be 2^n + 1 (e.g., 257, 513, 1025)
    ///
    /// # Panics
    ///
    /// Panics if size is not 2^n + 1.
    pub fn new(size: u32) -> Self {
        let tile_size = size - 1;
        if tile_size & (tile_size - 1) != 0 {
            panic!("Expected grid size to be 2^n+1, got {size}.")
        }
        let num_triangles = tile_size * tile_size * 2 - 2;
        Self {
            size,
            num_triangles,
            num_parent_triangles: num_triangles - tile_size * tile_size,
            coords: Self::construct_coords(tile_size, num_triangles as usize),
            index_map: vec![None; (size * size) as usize],
        }
    }

    /// Create a Martini instance with pre-computed coordinates.
    ///
    /// # Arguments
    ///
    /// * `size` - Grid size, must be 2^n + 1
    /// * `coords` - Pre-computed triangle coordinates
    ///
    /// # Panics
    ///
    /// Panics if size is not 2^n + 1.
    pub fn with_coords(size: u32, coords: Vec<u32>) -> Self {
        let tile_size = size - 1;
        if tile_size & (tile_size - 1) != 0 {
            panic!("Expected grid size to be 2^n+1, got {size}.")
        }
        let num_triangles = tile_size * tile_size * 2 - 2;
        Self {
            size,
            num_triangles,
            num_parent_triangles: num_triangles - tile_size * tile_size,
            coords,
            index_map: vec![None; (size * size) as usize],
        }
    }

    fn construct_coords(tile_size: u32, num_triangles: usize) -> Vec<u32> {
        let mut coords = vec![0; num_triangles * 4];

        // get triangle coordinates from its index in an implicit binary tree
        for i in 0..num_triangles {
            let mut id = i + 2;
            let mut ax = 0;
            let mut ay = 0;
            let mut bx = 0;
            let mut by = 0;
            let mut cx = 0;
            let mut cy = 0;

            if (id & 1) == 1 {
                bx = tile_size;
                by = tile_size;
                cx = tile_size; // bottom-left triangle
            } else {
                ax = tile_size;
                ay = tile_size;
                cy = tile_size; // top-right triangle
            }

            id >>= 1;
            while id > 1 {
                let mx = (ax + bx) >> 1;
                let my = (ay + by) >> 1;

                if (id & 1) == 1 {
                    // left half
                    bx = ax;
                    by = ay;
                    ax = cx;
                    ay = cy;
                } else {
                    // right half
                    ax = bx;
                    ay = by;
                    bx = cx;
                    by = cy;
                }
                cx = mx;
                cy = my;

                id >>= 1;
            }
            let k = i * 4;
            coords[k] = ax;
            coords[k + 1] = ay;
            coords[k + 2] = bx;
            coords[k + 3] = by;
        }

        coords
    }

    /// Create a terrain tile from height data.
    ///
    /// # Arguments
    ///
    /// * `get_height` - Function that returns height at grid coordinates (x, y)
    pub fn create_terrain<F>(&self, get_height: F) -> Tile
    where
        F: Fn(usize, usize) -> FloatType,
    {
        Tile::new(self, &get_height)
    }
}

/// A terrain tile with pre-computed error values.
///
/// Created from a Martini instance and height data, this struct holds
/// the error values needed for mesh generation at various detail levels.
pub struct Tile {
    errors: Vec<FloatType>,
}

impl Tile {
    fn new<F>(martini: &Martini, get_height: &F) -> Self
    where
        F: Fn(usize, usize) -> FloatType,
    {
        Self {
            errors: Self::compute_errors(martini, get_height),
        }
    }

    fn compute_errors<F>(martini: &Martini, get_height: &F) -> Vec<FloatType>
    where
        F: Fn(usize, usize) -> FloatType,
    {
        let Martini {
            num_triangles,
            num_parent_triangles,
            coords,
            size,
            index_map: _,
        } = martini;
        let size = *size as isize;
        let mut errors: Vec<FloatType> = vec![0.; (size * size) as usize];

        // iterate over all possible triangles, starting from the smallest level
        for i in (0..(*num_triangles as usize)).rev() {
            let k = i * 4;
            let ax = coords[k] as isize;
            let ay = coords[k + 1] as isize;
            let bx = coords[k + 2] as isize;
            let by = coords[k + 3] as isize;

            let mx = (ax + bx) >> 1;
            let my = (ay + by) >> 1;
            let cx = mx + my - ay;
            let cy = my + ax - mx;

            // calculate error in the middle of the long edge of the triangle
            let interpolated_height =
                (get_height(ax as usize, ay as usize) + get_height(bx as usize, by as usize)) / 2.;
            let middle_index = (my * size + mx) as usize;
            let middle_error = (interpolated_height - get_height(mx as usize, my as usize)).abs();

            errors[middle_index] = errors[middle_index].max(middle_error);

            // bigger triangles; accumulate error with children
            if i < (*num_parent_triangles as usize) {
                let left_child_index = (((ay + cy) >> 1) * size + ((ax + cx) >> 1)) as usize;
                let right_child_index = (((by + cy) >> 1) * size + ((bx + cx) >> 1)) as usize;
                errors[middle_index] = errors
                    .get(middle_index)
                    .map_or(0., |v| *v)
                    .max(errors.get(left_child_index).map_or(0., |v| *v))
                    .max(errors.get(right_child_index).map_or(0., |v| *v));
            }
        }

        errors
    }

    /// Construct a mesh from the computed error.
    ///
    /// # Arguments
    ///
    /// * `martini` - The Martini instance used to create this tile
    /// * `max_error` - Maximum allowed error threshold for mesh simplification
    /// * `transform` - Function to transform UV coordinates to 3D vertex positions
    ///
    /// # Returns
    ///
    /// A tuple of (vertices, indices, uvs):
    /// - vertices: Flat array of f32 [x, y, z, x, y, z, ...]
    /// - indices: Triangle indices as u32
    /// - uvs: Flat array of f32 [u, v, u, v, ...]
    pub fn construct_mesh<F>(
        &self,
        martini: &mut Martini,
        max_error: FloatType,
        transform: &mut F,
    ) -> (Vec<f32>, Vec<u32>, Vec<f32>)
    where
        F: FnMut((FloatType, FloatType)) -> (FloatType, FloatType, FloatType),
    {
        let size = martini.size;
        let index_map = &mut martini.index_map;

        let errors = &self.errors;

        let max = size - 1;

        index_map.fill(None);

        let mut vertices = vec![];
        let mut uvs = vec![];
        let mut indices = vec![];

        let mut num_vertices = 0;
        let mut new_index = || {
            let v = num_vertices;
            num_vertices += 1;
            Some(v)
        };

        let mut add_vertex = |x: u32, y: u32, i: usize| {
            let idx = index_map[i];
            if idx.is_none() {
                let u = (x as FloatType) / (max as FloatType);
                let v = 1. - (y as FloatType) / (max as FloatType);

                let (x, y, z) = transform((u, v));

                vertices.push(x as f32);
                vertices.push(y as f32);
                vertices.push(z as f32);

                uvs.push(u as f32);
                uvs.push(v as f32);

                index_map[i] = new_index();
            }

            index_map[i].unwrap()
        };

        let mut process_triangle = |(ax, ay, bx, by, cx, cy)| {
            let ai = (ay * size + ax) as usize;
            let bi = (by * size + bx) as usize;
            let ci = (cy * size + cx) as usize;

            let ai = add_vertex(ax, ay, ai);
            let bi = add_vertex(bx, by, bi);
            let ci = add_vertex(cx, cy, ci);

            indices.push(ai as u32);
            indices.push(bi as u32);
            indices.push(ci as u32);
        };

        Self::process_errors(
            &mut process_triangle,
            size,
            errors,
            &max_error,
            (0, 0, max, max, max, 0),
        );
        Self::process_errors(
            &mut process_triangle,
            size,
            errors,
            &max_error,
            (max, max, 0, 0, 0, max),
        );

        (vertices, indices, uvs)
    }

    fn process_errors<F>(
        cb: &mut F,
        size: u32,
        errors: &[FloatType],
        max_error: &FloatType,
        (ax, ay, bx, by, cx, cy): (u32, u32, u32, u32, u32, u32),
    ) where
        F: FnMut((u32, u32, u32, u32, u32, u32)),
    {
        let mx = (ax + bx) >> 1;
        let my = (ay + by) >> 1;

        if (ax as i32 - cx as i32).abs() + (ay as i32 - cy as i32).abs() > 1
            && &errors[(my * size + mx) as usize] > max_error
        {
            // triangle doesn't approximate the surface well enough; drill down further
            Self::process_errors(cb, size, errors, max_error, (cx, cy, ax, ay, mx, my));
            Self::process_errors(cb, size, errors, max_error, (bx, by, cx, cy, mx, my));
        } else {
            cb((ax, ay, bx, by, cx, cy));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_martini_new_valid_sizes() {
        // Test valid sizes: 2^n + 1
        let sizes = [3, 5, 9, 17, 33, 65, 129, 257, 513, 1025];
        for size in sizes {
            let martini = Martini::new(size);
            assert_eq!(martini.size, size);
        }
    }

    #[test]
    #[should_panic(expected = "Expected grid size to be 2^n+1")]
    fn test_martini_new_invalid_size() {
        Martini::new(100);
    }

    #[test]
    fn test_martini_coords_length() {
        let martini = Martini::new(9); // tile_size = 8
        let tile_size = 8;
        let num_triangles = tile_size * tile_size * 2 - 2;
        assert_eq!(martini.coords.len(), num_triangles as usize * 4);
    }

    #[test]
    fn test_flat_terrain_minimal_triangles() {
        // Flat terrain should produce minimal triangles (just 2 for the whole tile)
        let mut martini = Martini::new(9);
        let tile = martini.create_terrain(|_, _| 0.0);

        let (vertices, indices, uvs) =
            tile.construct_mesh(&mut martini, 0.0, &mut |(u, v)| (u, v, 0.0));

        // For a flat terrain with max_error = 0, we should get exactly 2 triangles
        // because there's no error to subdivide
        assert_eq!(indices.len() % 3, 0); // Must be multiple of 3
        assert_eq!(indices.len(), 6); // 2 triangles = 6 indices
        assert_eq!(vertices.len() % 3, 0); // xyz per vertex
        assert_eq!(uvs.len() % 2, 0); // uv per vertex
    }

    #[test]
    fn test_terrain_with_spike() {
        // Create terrain with a spike in the middle - should produce more triangles
        let mut martini = Martini::new(9);
        let tile = martini.create_terrain(|x, y| {
            if x == 4 && y == 4 {
                100.0 // spike in the middle
            } else {
                0.0
            }
        });

        let (_, indices_high_error, _) =
            tile.construct_mesh(&mut martini, 1000.0, &mut |(u, v)| (u, v, 0.0));

        let (_, indices_low_error, _) =
            tile.construct_mesh(&mut martini, 1.0, &mut |(u, v)| (u, v, 0.0));

        // Lower error tolerance should produce more triangles
        assert!(indices_low_error.len() >= indices_high_error.len());
    }

    #[test]
    fn test_transform_function_applied() {
        let mut martini = Martini::new(5);
        let tile = martini.create_terrain(|_, _| 0.0);

        let (vertices, _, _) = tile.construct_mesh(&mut martini, 0.0, &mut |(u, v)| {
            (u * 100.0, v * 100.0, 50.0) // Scale UV and set constant Z
        });

        // All Z values should be 50.0
        for i in (2..vertices.len()).step_by(3) {
            assert!((vertices[i] - 50.0).abs() < f32::EPSILON);
        }
    }

    #[test]
    fn test_uvs_in_valid_range() {
        let mut martini = Martini::new(17);
        let tile = martini.create_terrain(|x, y| (x + y) as f64);

        let (_, _, uvs) = tile.construct_mesh(&mut martini, 0.5, &mut |(u, v)| (u, v, 0.0));

        for uv in &uvs {
            assert!(*uv >= 0.0 && *uv <= 1.0, "UV out of range: {uv}",);
        }
    }

    #[test]
    fn test_indices_valid() {
        let mut martini = Martini::new(17);
        let tile = martini.create_terrain(|x, y| ((x * y) as f64).sin() * 10.0);

        let (vertices, indices, _) =
            tile.construct_mesh(&mut martini, 1.0, &mut |(u, v)| (u, v, 0.0));

        let num_vertices = vertices.len() / 3;
        for idx in &indices {
            assert!(
                (*idx as usize) < num_vertices,
                "Index {idx} out of bounds (num_vertices: {num_vertices})",
            );
        }
    }

    #[test]
    fn test_with_coords() {
        let martini1 = Martini::new(9);
        let coords = martini1.coords.clone();

        let martini2 = Martini::with_coords(9, coords.clone());

        assert_eq!(martini1.size, martini2.size);
        assert_eq!(martini1.coords, martini2.coords);
        assert_eq!(martini1.num_triangles, martini2.num_triangles);
    }

    #[test]
    fn test_larger_grid() {
        let mut martini = Martini::new(257);
        let tile = martini.create_terrain(|x, y| {
            // Simulate some terrain with variation
            (x as f64 / 32.0).sin() * (y as f64 / 32.0).cos() * 100.0
        });

        let (vertices, indices, uvs) =
            tile.construct_mesh(&mut martini, 5.0, &mut |(u, v)| (u, v, 0.0));

        assert!(!vertices.is_empty());
        assert!(!indices.is_empty());
        assert!(!uvs.is_empty());
        assert_eq!(vertices.len() / 3, uvs.len() / 2);
    }
}
