//! Standalone FastEnhancer streaming inference for WebAssembly (no ONNX Runtime).
//!
//! The network itself lives in `generated/model_*.rs`, emitted by `wasm/compiler/fe_compile.py`
//! from the ONNX export. Exactly one model is compiled in, selected by cargo feature.
//!
//! C ABI (all sizes in f32 elements):
//!   fe_hop_size() -> u32                  samples per hop (512)
//!   fe_stream_new() -> *Stream            independent stream (one per audio channel)
//!   fe_stream_free(s)
//!   fe_stream_input(s) / fe_stream_output(s) -> *f32   HOP-sized I/O buffers
//!   fe_stream_process(s, wet)             output = input*(1-wet) + enhanced*wet
//!   fe_stream_reset(s)                    zero the recurrent/overlap caches
//!   fe_num_caches(), fe_cache_len(i), fe_stream_cache(s, i)   cache introspection

#[cfg(all(feature = "model_s", feature = "model_t"))]
compile_error!("enable exactly one of the `model_s` / `model_t` features");
#[cfg(not(any(feature = "model_s", feature = "model_t")))]
compile_error!("enable one of the `model_s` / `model_t` features");

pub mod kernels;

#[cfg_attr(feature = "model_s", path = "generated/model_s.rs")]
#[cfg_attr(all(feature = "model_t", not(feature = "model_s")), path = "generated/model_t.rs")]
pub mod model;

use model::{ARENA_LEN, CACHE_LENS, HOP, NCACHE, WEIGHTS, WEIGHTS_LEN};

/// Per-kernel timing (build with `--features profile`; needs an `env.fe_now() -> f64` ms clock import).
#[cfg(feature = "profile")]
pub mod prof {
    use crate::model::PROF_LABELS;
    const N: usize = PROF_LABELS.len();
    static mut TIMES: [f64; N] = [0.0; N];
    static mut LAST: f64 = 0.0;

    #[link(wasm_import_module = "env")]
    extern "C" {
        fn fe_now() -> f64;
    }

    #[inline(always)]
    pub fn start() {
        unsafe { LAST = fe_now() }
    }

    #[inline(always)]
    pub fn mark(i: usize) {
        unsafe {
            let t = fe_now();
            TIMES[i] += t - LAST;
            LAST = t;
        }
    }

    #[no_mangle]
    pub extern "C" fn fe_prof_len() -> u32 {
        N as u32
    }

    #[no_mangle]
    pub extern "C" fn fe_prof_times() -> *mut f64 {
        core::ptr::addr_of_mut!(TIMES) as *mut f64
    }

    #[no_mangle]
    pub extern "C" fn fe_prof_label_ptr(i: u32) -> *const u8 {
        PROF_LABELS[i as usize].as_ptr()
    }

    #[no_mangle]
    pub extern "C" fn fe_prof_label_len(i: u32) -> u32 {
        PROF_LABELS[i as usize].len() as u32
    }
}

pub struct Stream {
    arena: Vec<f32>,
    input: Vec<f32>,
    output: Vec<f32>,
    enhanced: Vec<f32>,
    cur: Vec<Vec<f32>>,
    next: Vec<Vec<f32>>,
}

impl Stream {
    pub fn new() -> Self {
        let caches = || CACHE_LENS.iter().map(|&n| vec![0.0f32; n]).collect::<Vec<_>>();
        Stream {
            arena: vec![0.0; ARENA_LEN],
            input: vec![0.0; HOP],
            output: vec![0.0; HOP],
            enhanced: vec![0.0; HOP],
            cur: caches(),
            next: caches(),
        }
    }

    pub fn reset(&mut self) {
        for c in self.cur.iter_mut().chain(self.next.iter_mut()) {
            c.fill(0.0);
        }
        self.input.fill(0.0);
        self.output.fill(0.0);
        self.enhanced.fill(0.0);
    }

    /// HOP-sized input buffer, read by the next `process()` (for native Rust callers).
    pub fn input_mut(&mut self) -> &mut [f32] {
        &mut self.input
    }

    /// HOP-sized output buffer, written by `process()` (for native Rust callers).
    pub fn output(&self) -> &[f32] {
        &self.output
    }

    /// Make this stream's recurrent/overlap state identical to `src`.
    pub fn copy_state_from(&mut self, src: &Stream) {
        for (d, s) in self.cur.iter_mut().zip(src.cur.iter()) {
            d.copy_from_slice(s);
        }
    }

    pub fn process(&mut self, wet: f32) {
        debug_assert_eq!(WEIGHTS.0.len(), WEIGHTS_LEN * 4);
        let ci: [*const f32; NCACHE] = core::array::from_fn(|i| self.cur[i].as_ptr());
        let co: [*mut f32; NCACHE] = core::array::from_fn(|i| self.next[i].as_mut_ptr());
        unsafe {
            model::run(
                self.arena.as_mut_ptr(),
                WEIGHTS.0.as_ptr() as *const f32,
                self.input.as_ptr(),
                self.enhanced.as_mut_ptr(),
                &ci,
                &co,
            );
        }
        core::mem::swap(&mut self.cur, &mut self.next);
        let dry = 1.0 - wet;
        for i in 0..HOP {
            self.output[i] = self.input[i] * dry + self.enhanced[i] * wet;
        }
    }
}

impl Default for Stream {
    fn default() -> Self {
        Self::new()
    }
}

#[no_mangle]
pub extern "C" fn fe_hop_size() -> u32 {
    HOP as u32
}

#[no_mangle]
pub extern "C" fn fe_num_caches() -> u32 {
    NCACHE as u32
}

#[no_mangle]
pub extern "C" fn fe_cache_len(i: u32) -> u32 {
    CACHE_LENS.get(i as usize).copied().unwrap_or(0) as u32
}

#[no_mangle]
pub extern "C" fn fe_stream_new() -> *mut Stream {
    Box::into_raw(Box::new(Stream::new()))
}

/// # Safety
/// `s` must come from `fe_stream_new` and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn fe_stream_free(s: *mut Stream) {
    if !s.is_null() {
        drop(Box::from_raw(s));
    }
}

/// # Safety
/// `s` must be a live stream.
#[no_mangle]
pub unsafe extern "C" fn fe_stream_input(s: *mut Stream) -> *mut f32 {
    (&mut *s).input.as_mut_ptr()
}

/// # Safety
/// `s` must be a live stream.
#[no_mangle]
pub unsafe extern "C" fn fe_stream_output(s: *mut Stream) -> *mut f32 {
    (&mut *s).output.as_mut_ptr()
}

/// # Safety
/// `s` must be a live stream.
#[no_mangle]
pub unsafe extern "C" fn fe_stream_process(s: *mut Stream, wet: f32) {
    (&mut *s).process(wet.clamp(0.0, 1.0));
}

/// # Safety
/// `s` must be a live stream.
#[no_mangle]
pub unsafe extern "C" fn fe_stream_reset(s: *mut Stream) {
    (&mut *s).reset();
}

/// Copy the model state of `src` into `dst` (used to skip duplicate work on mono audio).
///
/// # Safety
/// Both must be live, distinct streams.
#[no_mangle]
pub unsafe extern "C" fn fe_stream_copy_state(dst: *mut Stream, src: *const Stream) {
    if dst as *const Stream != src {
        (&mut *dst).copy_state_from(&*src);
    }
}

/// Current (most recently produced) cache `i`. The pointer is only valid until the next process().
///
/// # Safety
/// `s` must be a live stream.
#[no_mangle]
pub unsafe extern "C" fn fe_stream_cache(s: *mut Stream, i: u32) -> *mut f32 {
    let s = &mut *s;
    match s.cur.get_mut(i as usize) {
        Some(c) => c.as_mut_ptr(),
        None => core::ptr::null_mut(),
    }
}
