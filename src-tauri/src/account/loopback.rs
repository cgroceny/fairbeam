// The loopback redirect for installed-app OAuth (RFC 8252 7.3): a one-shot HTTP listener on
// 127.0.0.1:<random port> that receives `GET /callback?code=...&state=...` from the browser.

use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

use super::provider::{AuthError, Cancel, Clock};

pub const CALLBACK_PATH: &str = "/callback";
/// How long the browser has to come back.
pub const WAIT: Duration = Duration::from_secs(300);
const POLL: Duration = Duration::from_millis(150);

pub struct Loopback {
    listener: TcpListener,
    port: u16,
}

impl Loopback {
    pub fn bind() -> Result<Loopback, AuthError> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .map_err(|e| AuthError::Network(format!("could not open the loopback port: {e}")))?;
        let port = listener.local_addr().map_err(|e| AuthError::Network(e.to_string()))?.port();
        listener.set_nonblocking(true).map_err(|e| AuthError::Network(e.to_string()))?;
        Ok(Loopback { listener, port })
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{CALLBACK_PATH}", self.port)
    }

    /// Waits for the callback and returns the authorization code. Other requests (favicon) get a
    /// 404 and the wait goes on; a bad state or an OAuth error ends it.
    pub async fn wait<C: Clock>(
        &self,
        clock: &C,
        state: &str,
        cancel: &Cancel,
        timeout: Duration,
    ) -> Result<String, AuthError> {
        let deadline = clock.now() + timeout.as_secs();
        loop {
            if cancel.is_cancelled() {
                return Err(AuthError::Cancelled);
            }
            if clock.now() >= deadline {
                return Err(AuthError::Expired);
            }
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if let Some(result) = answer(stream, state) {
                        return result;
                    }
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::Interrupted => {
                    clock.sleep(POLL).await
                }
                Err(e) => return Err(AuthError::Network(e.to_string())),
            }
        }
    }
}

/// Reads one request and answers it; none: not the callback, keep waiting.
fn answer(mut stream: TcpStream, state: &str) -> Option<Result<String, AuthError>> {
    // accepted sockets inherit non-blocking mode on macOS
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut head = Vec::new();
    let mut buf = [0u8; 1024];
    while head.len() < 8192 && !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
    }
    let head = String::from_utf8_lossy(&head);
    let result = parse_request(&head, state);
    let (status, text) = match &result {
        Ok(None) => ("404 Not Found", "Not found."),
        Ok(Some(_)) => ("200 OK", "Signed in. You can close this tab and return to Fairbeam."),
        Err(AuthError::Denied) => ("200 OK", "Sign-in was declined. You can close this tab."),
        Err(_) => ("400 Bad Request", "This sign-in request is not valid. Please return to Fairbeam and try again."),
    };
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Fairbeam</title>\
         <body style=\"font:16px system-ui,sans-serif;margin:3em\"><p>{text}</p></body>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
    result.transpose()
}

/// Parses the request head. `Ok(Some(code))`: the callback with a matching state;
/// `Ok(None)`: some other path; errors: a bad or missing state, an OAuth error, no code.
pub fn parse_request(head: &str, expected_state: &str) -> Result<Option<String>, AuthError> {
    let line = head.lines().next().unwrap_or("");
    let mut parts = line.split(' ');
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if method != "GET" || !target.starts_with('/') {
        return Err(AuthError::Invalid("not an HTTP GET".into()));
    }
    let url = url::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| AuthError::Invalid("bad callback URL".into()))?;
    if url.path() != CALLBACK_PATH {
        return Ok(None);
    }
    let param = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
    // the state is checked first: an error from someone else's request must not end ours quietly
    match param("state") {
        Some(s) if !expected_state.is_empty() && constant_time_eq(s.as_bytes(), expected_state.as_bytes()) => {}
        _ => return Err(AuthError::State),
    }
    if let Some(error) = param("error") {
        return Err(if error == "access_denied" {
            AuthError::Denied
        } else {
            AuthError::Provider { code: error, description: param("error_description") }
        });
    }
    match param("code") {
        Some(code) if !code.is_empty() => Ok(Some(code)),
        _ => Err(AuthError::Invalid("the callback has no code".into())),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::provider::fakes::{block_on, FakeClock, ThreadClock};

    const HEAD: &str = "\r\nHost: 127.0.0.1:5000\r\n\r\n";

    fn get(target: &str) -> String {
        format!("GET {target} HTTP/1.1{HEAD}")
    }

    #[test]
    fn callback_with_matching_state_gives_the_code() {
        let r = parse_request(&get("/callback?state=abc&code=4%2F0Ab_x&scope=email"), "abc");
        assert_eq!(r, Ok(Some("4/0Ab_x".into())));
    }

    #[test]
    fn state_mismatch_or_missing_is_rejected() {
        assert_eq!(parse_request(&get("/callback?state=evil&code=x"), "abc"), Err(AuthError::State));
        assert_eq!(parse_request(&get("/callback?code=x"), "abc"), Err(AuthError::State));
        assert_eq!(parse_request(&get("/callback?state=&code=x"), ""), Err(AuthError::State));
        // an injected error with the wrong state is a state error, not a refusal
        assert_eq!(parse_request(&get("/callback?error=access_denied&state=evil"), "abc"), Err(AuthError::State));
    }

    #[test]
    fn oauth_errors_and_missing_codes() {
        assert_eq!(parse_request(&get("/callback?error=access_denied&state=abc"), "abc"), Err(AuthError::Denied));
        assert_eq!(
            parse_request(&get("/callback?error=invalid_scope&error_description=bad+scope&state=abc"), "abc"),
            Err(AuthError::Provider { code: "invalid_scope".into(), description: Some("bad scope".into()) })
        );
        assert!(matches!(parse_request(&get("/callback?state=abc"), "abc"), Err(AuthError::Invalid(_))));
        assert!(matches!(parse_request(&get("/callback?state=abc&code="), "abc"), Err(AuthError::Invalid(_))));
    }

    #[test]
    fn other_paths_and_garbage() {
        assert_eq!(parse_request(&get("/favicon.ico"), "abc"), Ok(None));
        assert_eq!(parse_request(&get("/callbackx?state=abc&code=1"), "abc"), Ok(None));
        assert!(matches!(parse_request("POST /callback HTTP/1.1\r\n\r\n", "abc"), Err(AuthError::Invalid(_))));
        assert!(matches!(parse_request("", "abc"), Err(AuthError::Invalid(_))));
        assert!(matches!(parse_request("GET http://evil/ HTTP/1.1\r\n\r\n", "abc"), Err(AuthError::Invalid(_))));
    }

    #[test]
    fn listener_skips_favicon_then_takes_the_code() {
        let lb = Loopback::bind().unwrap();
        let uri = lb.redirect_uri();
        assert!(uri.starts_with("http://127.0.0.1:") && uri.ends_with("/callback"));
        let port = lb.port;
        let browser = std::thread::spawn(move || {
            let send = |target: &str| {
                let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
                write!(s, "GET {target} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
                let mut out = String::new();
                let _ = s.read_to_string(&mut out);
                out
            };
            let a = send("/favicon.ico");
            let b = send("/callback?state=st&code=the-code");
            (a, b)
        });
        let code = block_on(lb.wait(&ThreadClock, "st", &Cancel::default(), Duration::from_secs(10)));
        let (a, b) = browser.join().unwrap();
        assert_eq!(code, Ok("the-code".into()));
        assert!(a.starts_with("HTTP/1.1 404"));
        assert!(b.starts_with("HTTP/1.1 200") && b.contains("close this tab"));
    }

    #[test]
    fn wait_ends_on_cancel_and_timeout() {
        let lb = Loopback::bind().unwrap();
        let cancel = Cancel::default();
        cancel.cancel();
        let clock = FakeClock::at(1000);
        assert_eq!(block_on(lb.wait(&clock, "s", &cancel, WAIT)), Err(AuthError::Cancelled));
        let clock = FakeClock::at(1000);
        assert_eq!(block_on(lb.wait(&clock, "s", &Cancel::default(), Duration::from_secs(2))), Err(AuthError::Expired));
        assert!(clock.now() >= 1002);
    }
}
