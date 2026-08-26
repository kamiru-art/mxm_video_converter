//! mxm-core: núcleo de MXM Studio (hojas de contacto, marcadores, cianotipia,
//! procesado de escaneos y calibración), compilable a WebAssembly.

pub mod api;
pub mod aruco;
pub mod aruco_dicts;
pub mod calib;
pub mod codecs;
pub mod geometry;
pub mod img;
pub mod cyanotype;
pub mod dedup;
pub mod imgproc;
pub mod layoutfile;
pub mod scanproc;
pub mod pdf;
pub mod qr;
pub mod sheet;
pub mod text;
