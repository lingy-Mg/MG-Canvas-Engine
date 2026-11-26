use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileType, FILE_TYPE_DISK, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
};

#[cfg(windows)]
pub mod pipe;

const PROJECT_LIMIT: usize = 72 * 1024 * 1024;
pub const ARGUMENT_LIMIT: usize = 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "action",
    content = "args",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Request {
    Focus,
    Tools,
    Call { name: String, arguments: Value },
    Open { path: std::path::PathBuf },
    Snapshot,
}

#[derive(Debug, Serialize)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}

impl Failure {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn io(error: io::Error) -> Self {
        Self::new("IO", error.to_string())
    }

    pub fn result(&self) -> Value {
        json!({"ok":false,"code":self.code,"message":self.message})
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Failure {}

pub fn read_project(path: &Path) -> Result<String, Failure> {
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mgcanvas"))
    {
        return Err(Failure::new("INVALID", "Expected a .mgcanvas project file"));
    }
    let file = open_input(path)?;
    let metadata = file.metadata().map_err(Failure::io)?;
    if !metadata.is_file() {
        return Err(Failure::new("INVALID", "Expected a regular project file"));
    }
    if metadata.len() > PROJECT_LIMIT as u64 {
        return Err(Failure::new(
            "TOO_LARGE",
            "Project exceeds the 72 MiB file limit",
        ));
    }
    read_utf8(file, PROJECT_LIMIT)
}

pub fn open_input(path: &Path) -> Result<File, Failure> {
    let file = OpenOptions::new()
        .read(true)
        .security_qos_flags(SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION)
        .open(path)
        .map_err(Failure::io)?;
    if unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK {
        return Err(Failure::new("INVALID", "Expected a regular disk file"));
    }
    Ok(file)
}

pub fn read_utf8(reader: impl Read, limit: usize) -> Result<String, Failure> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(Failure::io)?;
    if bytes.len() > limit {
        return Err(Failure::new(
            "TOO_LARGE",
            format!("Input exceeds {limit} bytes"),
        ));
    }
    let mut input =
        String::from_utf8(bytes).map_err(|_| Failure::new("INVALID", "Input must be UTF-8"))?;
    if input.starts_with('\u{feff}') {
        input.drain(..'\u{feff}'.len_utf8());
    }
    Ok(input)
}

pub fn write_new(path: &Path, data: &[u8]) -> Result<(), Failure> {
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(Failure::io)?;
    temp.write_all(data).map_err(Failure::io)?;
    temp.as_file().sync_all().map_err(Failure::io)?;
    temp.persist_noclobber(path).map_err(|failure| {
        if failure.error.kind() == io::ErrorKind::AlreadyExists {
            Failure::new("EXISTS", "Output already exists")
        } else {
            Failure::io(failure.error)
        }
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_limited_utf8_with_optional_bom() {
        assert_eq!(read_utf8("\u{feff}审批".as_bytes(), 9).unwrap(), "审批");
        assert_eq!(
            read_utf8("审批".as_bytes(), 5).unwrap_err().code,
            "TOO_LARGE"
        );
        assert_eq!(read_utf8(&[0xff][..], 1).unwrap_err().code, "INVALID");
    }

    #[test]
    fn output_never_clobbers_existing_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("已有.mgcanvas");
        write_new(&path, b"first").unwrap();
        assert_eq!(write_new(&path, b"second").unwrap_err().code, "EXISTS");
        assert_eq!(std::fs::read(path).unwrap(), b"first");
    }
}
