// The `fairbeam serve` child: started in its own process group (Windows: also in a job object,
// so it dies with the app), stopped gracefully through POST /api/shutdown with a per-start token,
// then by signal / job termination after a grace period.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command};
use std::thread;
use std::time::{Duration, Instant};

pub struct Server {
    pub child: Child,
    pub port: u16,
    token: String,
    #[cfg(windows)]
    job: Option<win::Job>,
}

pub fn free_port() -> Option<u16> {
    TcpListener::bind("127.0.0.1:0").ok()?.local_addr().ok().map(|a| a.port())
}

/// `preferred` while it can be bound on 127.0.0.1, else a free port: the viewer's origin, and with
/// it its localStorage, then stays the same from one start to the next.
pub fn stable_port(preferred: Option<u16>) -> Option<u16> {
    preferred
        .filter(|&p| p >= 1024 && TcpListener::bind(("127.0.0.1", p)).is_ok())
        .or_else(free_port)
}

/// A random token (std only: RandomState is seeded from the OS).
pub fn token() -> String {
    let mut s = String::new();
    for _ in 0..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(Instant::now().elapsed().as_nanos() ^ u128::from(std::process::id()));
        s.push_str(&format!("{:016x}", h.finish()));
    }
    s
}

const READ_LIMIT: Duration = Duration::from_secs(3);
const READ_CAP: usize = 64 * 1024;

/// Send a `Connection: close` request and return the answer's status code. The whole answer is
/// read (to EOF, at most READ_CAP bytes within READ_LIMIT) before the socket closes: closing it
/// with unread data makes the OS reset the connection, which the server sees as an error.
fn request(port: u16, raw: &str) -> Option<u16> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    let _ = s.set_read_timeout(Some(READ_LIMIT));
    s.write_all(raw.as_bytes()).ok()?;
    let deadline = Instant::now() + READ_LIMIT;
    let mut answer = Vec::new();
    let mut buf = [0u8; 4096];
    while answer.len() < READ_CAP {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || s.set_read_timeout(Some(left)).is_err() {
            break;
        }
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => answer.extend_from_slice(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    // "HTTP/1.1 202 Accepted"
    if answer.len() < 12 || !answer.starts_with(b"HTTP/") {
        return None;
    }
    std::str::from_utf8(&answer[9..12]).ok()?.parse().ok()
}

/// GET a path on 127.0.0.1 and return true for a 2xx/3xx answer.
pub fn http_ok(port: u16, path: &str) -> bool {
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    matches!(request(port, &req), Some(c) if (200..400).contains(&c))
}

impl Server {
    /// Spawn `cmd` (already configured with arguments and output) as the server.
    pub fn spawn(mut cmd: Command, port: u16) -> std::io::Result<Server> {
        let token = token();
        cmd.env("FAIRBEAM_SHUTDOWN_TOKEN", &token);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_SUSPENDED: the process is put
            // into the job before it runs, so everything it starts is in the job too (the venv
            // python.exe is a launcher that starts the real interpreter right away)
            cmd.creation_flags(0x0000_0200 | 0x0800_0000 | 0x0000_0004);
        }
        let child = cmd.spawn()?;
        #[cfg(windows)]
        let (child, job) = {
            let mut child = child;
            let job = win::Job::new().filter(|j| j.assign(&child));
            if !win::resume(&child) {
                // never leave a suspended process behind
                let _ = child.kill();
                let _ = child.wait();
                return Err(std::io::Error::new(std::io::ErrorKind::Other, "could not resume the server process"));
            }
            (child, job)
        };
        Ok(Server {
            child,
            port,
            token,
            #[cfg(windows)]
            job,
        })
    }

    pub fn exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)) | Err(_))
    }

    fn wait_exit(&mut self, limit: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < limit {
            if self.exited() {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        self.exited()
    }

    /// Graceful stop (the server cancels its runs and shuts down), forced after the grace period.
    pub fn stop(mut self) {
        let req = format!(
            "POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nContent-Type: application/json\r\nX-Fairbeam-Token: {t}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}",
            p = self.port,
            t = self.token
        );
        let asked = request(self.port, &req) == Some(202);
        if asked && self.wait_exit(Duration::from_secs(8)) {
            self.cleanup();
            return;
        }
        #[cfg(unix)]
        {
            let pgid = self.child.id() as i32;
            unsafe {
                libc::kill(-pgid, libc::SIGTERM);
            }
            self.wait_exit(Duration::from_secs(5));
            unsafe {
                libc::kill(-pgid, libc::SIGKILL); // stragglers of the group, or a hung server
            }
        }
        #[cfg(windows)]
        {
            match &self.job {
                Some(j) => j.terminate(),
                None => {
                    let _ = self.child.kill();
                }
            }
        }
        let _ = self.child.wait();
        self.cleanup();
    }

    fn cleanup(&mut self) {
        #[cfg(windows)]
        {
            self.job = None; // closing the job handle kills anything left in it
        }
    }
}

#[cfg(windows)]
mod win {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    #[link(name = "ntdll")]
    extern "system" {
        // undocumented but stable since Windows XP; fairbeam/procutil.py uses it the same way.
        // std::process::Child has no handle to the main thread for ResumeThread.
        fn NtResumeProcess(process: HANDLE) -> i32;
    }

    /// Resume a process started with CREATE_SUSPENDED.
    pub fn resume(child: &Child) -> bool {
        unsafe { NtResumeProcess(child.as_raw_handle() as HANDLE) >= 0 }
    }

    /// A job object whose processes die when it is terminated or its last handle closes (also
    /// when the app itself dies).
    pub struct Job(HANDLE);

    unsafe impl Send for Job {}

    impl Job {
        pub fn new() -> Option<Job> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(h);
                    return None;
                }
                Some(Job(h))
            }
        }

        pub fn assign(&self, child: &Child) -> bool {
            unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) != 0 }
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Shutdown;
    use std::thread::JoinHandle;

    /// A one-shot HTTP server on 127.0.0.1: reads the request head, sends `parts` with a pause
    /// between them, closes its side and returns what its next read gives: Ok(0) when the client
    /// closed in order, an error when the client reset the connection.
    fn serve(parts: Vec<Vec<u8>>) -> (u16, JoinHandle<std::io::Result<usize>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut s, _) = listener.accept()?;
            let (mut head, mut buf) = (Vec::new(), [0u8; 1024]);
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                match s.read(&mut buf)? {
                    0 => break,
                    n => head.extend_from_slice(&buf[..n]),
                }
            }
            for part in parts {
                s.write_all(&part)?;
                thread::sleep(Duration::from_millis(50));
            }
            s.shutdown(Shutdown::Write)?;
            s.set_read_timeout(Some(Duration::from_secs(5)))?;
            s.read(&mut buf)
        });
        (port, handle)
    }

    fn get(port: u16) -> String {
        format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
    }

    #[test]
    fn stable_port_keeps_a_free_port_and_moves_off_a_taken_one() {
        let free = free_port().unwrap();
        assert_eq!(stable_port(Some(free)), Some(free));
        let taken = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = taken.local_addr().unwrap().port();
        let other = stable_port(Some(p)).unwrap();
        assert_ne!(other, p);
        assert!(stable_port(None).is_some());
        assert_ne!(stable_port(Some(80)), Some(80));
    }

    #[test]
    fn reads_the_answer_to_the_end() {
        let (port, server) = serve(vec![
            b"HTTP/1.1 202 Accepted\r\n".to_vec(),
            b"Content-Type: application/json\r\nContent-Length: 13\r\nConnection: close\r\n\r\n".to_vec(),
            b"{\"ok\": true}\n".to_vec(),
        ]);
        assert_eq!(request(port, &get(port)), Some(202));
        // the client read everything and closed in order: no reset reaches the server
        assert_eq!(server.join().unwrap().unwrap(), 0);
    }

    #[test]
    fn health_poll() {
        let (port, server) = serve(vec![b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok".to_vec()]);
        let start = Instant::now();
        assert!(http_ok(port, "/api/health"));
        assert!(start.elapsed() < Duration::from_secs(1));
        assert_eq!(server.join().unwrap().unwrap(), 0);
    }

    #[test]
    fn stops_at_the_size_cap() {
        let mut body = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        body.resize(4 * READ_CAP, b'x');
        let (port, server) = serve(vec![body]);
        let start = Instant::now();
        assert_eq!(request(port, &get(port)), Some(200));
        assert!(start.elapsed() < READ_LIMIT);
        let _ = server.join(); // the server's write fails once the client closes: expected
    }

    #[test]
    fn not_http() {
        let (port, server) = serve(vec![b"hello there\r\n".to_vec()]);
        assert_eq!(request(port, &get(port)), None);
        let _ = server.join();
    }
}