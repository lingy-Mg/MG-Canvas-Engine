use super::{Failure, Request, ARGUMENT_LIMIT};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    env, io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr::{null_mut, NonNull},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions},
    time::{sleep, timeout, Instant},
};
use windows_sys::Win32::{
    Foundation::{LocalFree, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT,
        },
        EqualSid, GetTokenInformation, TokenUser, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::SECURITY_IDENTIFICATION,
    System::{
        RemoteDesktop::ProcessIdToSessionId,
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

pub const CAPACITY: usize = 8;
const FRAME_LIMIT: usize = 160 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
pub const TRANSFER_TIMEOUT: Duration = Duration::from_secs(10);
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(120);

struct LocalAllocation(NonNull<std::ffi::c_void>);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0.as_ptr()) };
    }
}

struct User(Vec<usize>);

impl User {
    fn current() -> io::Result<Self> {
        let mut token = null_mut();
        unsafe {
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let token = OwnedHandle::from_raw_handle(token);
            let mut length = 0;
            GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut length);
            if length == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut buffer = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
            if GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                buffer.as_mut_ptr().cast(),
                length,
                &mut length,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(buffer))
        }
    }

    fn sid(&self) -> PSID {
        unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }

    fn sid_string(&self) -> io::Result<String> {
        let mut sid = null_mut();
        unsafe {
            if ConvertSidToStringSidW(self.sid(), &mut sid) == 0 {
                return Err(io::Error::last_os_error());
            }
            let _allocation = LocalAllocation(NonNull::new(sid.cast()).unwrap());
            let length = (0..).take_while(|&index| *sid.add(index) != 0).count();
            Ok(String::from_utf16_lossy(std::slice::from_raw_parts(
                sid, length,
            )))
        }
    }
}

pub struct Endpoint {
    name: String,
    user: User,
    descriptor: Vec<u16>,
}

impl Endpoint {
    pub fn current() -> io::Result<Self> {
        let user = User::current()?;
        let sid = user.sid_string()?;
        let mut session = 0;
        if unsafe { ProcessIdToSessionId(std::process::id(), &mut session) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let instance = env::var("MGCANVAS_INSTANCE").unwrap_or_default();
        let key = Sha256::digest(format!("{sid}:{session}:{instance}").as_bytes());
        let name = format!(r"\\.\pipe\MGCanvas.Workbench.v1.{key:x}");
        let descriptor = format!("O:{sid}D:P(A;;GA;;;{sid})")
            .encode_utf16()
            .chain([0])
            .collect();
        Ok(Self {
            name,
            user,
            descriptor,
        })
    }

    pub fn server(&self, first: bool) -> io::Result<NamedPipeServer> {
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        unsafe {
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                self.descriptor.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let _allocation = LocalAllocation(NonNull::new(descriptor).unwrap());
            let mut attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            };
            ServerOptions::new()
                .first_pipe_instance(first)
                .max_instances(CAPACITY + 1)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(
                    &self.name,
                    std::ptr::from_mut(&mut attributes).cast(),
                )
        }
    }

    fn verify_owner(&self, client: &NamedPipeClient) -> io::Result<()> {
        let mut owner = null_mut();
        let mut descriptor = null_mut();
        unsafe {
            let status = GetSecurityInfo(
                client.as_raw_handle(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            );
            if status != 0 {
                return Err(io::Error::from_raw_os_error(status as i32));
            }
            let _allocation = LocalAllocation(NonNull::new(descriptor).unwrap());
            if owner.is_null() || EqualSid(owner, self.user.sid()) == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Pipe owner does not match the Windows user",
                ));
            }
        }
        Ok(())
    }

    async fn client(&self) -> Result<NamedPipeClient, Failure> {
        let until = Instant::now() + CONNECT_TIMEOUT;
        loop {
            match ClientOptions::new()
                .security_qos_flags(SECURITY_IDENTIFICATION)
                .open(&self.name)
            {
                Ok(client) => {
                    self.verify_owner(&client).map_err(|error| {
                        Failure::new(
                            "ACCESS_DENIED",
                            format!("Could not verify the workbench pipe owner: {error}"),
                        )
                    })?;
                    return Ok(client);
                }
                Err(error) => match error.raw_os_error().map(|code| code as u32) {
                    Some(ERROR_FILE_NOT_FOUND) => {
                        return Err(Failure::new(
                            "NO_WINDOW",
                            "Open the MG Canvas desktop workbench first",
                        ))
                    }
                    Some(ERROR_PIPE_BUSY) if Instant::now() < until => {
                        sleep(Duration::from_millis(30)).await
                    }
                    Some(ERROR_PIPE_BUSY) => {
                        return Err(Failure::new("BUSY", "The workbench command pipe is busy"))
                    }
                    Some(ERROR_ACCESS_DENIED) => {
                        return Err(Failure::new(
                            "ACCESS_DENIED",
                            format!("Could not connect to the workbench pipe: {error}"),
                        ))
                    }
                    _ => return Err(Failure::io(error)),
                },
            }
        }
    }

    pub async fn exchange(&self, request: &Request) -> Result<Value, Failure> {
        let mut client = self.client().await?;
        let duration = if matches!(request, Request::Open { .. }) {
            OPEN_TIMEOUT
        } else {
            COMMAND_TIMEOUT
        };
        let result = timeout(duration + TRANSFER_TIMEOUT * 3, async {
            write_frame(&mut client, request).await?;
            read_frame(&mut client, FRAME_LIMIT).await
        })
        .await;
        let result = match result {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                return Err(Failure::new(
                    "UNKNOWN_OUTCOME",
                    format!("Workbench response was interrupted: {error}"),
                ))
            }
            Err(_) => {
                return Err(Failure::new(
                    "UNKNOWN_OUTCOME",
                    "Workbench response timed out",
                ))
            }
        };
        // Keep the server handle open until the complete reply has been read.
        let _ = timeout(Duration::from_secs(1), client.write_u8(1)).await;
        Ok(result)
    }
}

pub async fn read_request(pipe: &mut NamedPipeServer) -> io::Result<Request> {
    read_frame(pipe, ARGUMENT_LIMIT * 2).await
}

async fn read_frame<T: DeserializeOwned>(
    pipe: &mut (impl AsyncRead + Unpin),
    limit: usize,
) -> io::Result<T> {
    let length = pipe.read_u32_le().await? as usize;
    if length == 0 || length > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid frame length",
        ));
    }
    let mut bytes = vec![0u8; length];
    pipe.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

pub async fn write_frame(
    pipe: &mut (impl AsyncWrite + Unpin),
    payload: &impl Serialize,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(payload).map_err(io::Error::other)?;
    if bytes.len() > FRAME_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Frame exceeds transport limit",
        ));
    }
    pipe.write_u32_le(bytes.len() as u32).await?;
    pipe.write_all(&bytes).await
}

pub fn runtime() -> io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
}
