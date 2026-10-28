//! Native regression test: no desktop input, hidden window, isolated profile.
//! cargo run --example webview_smoke [-- --live]
#[cfg(not(windows))]
fn main() {
    eprintln!("This regression test requires Windows/WebView2");
}

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::{
        cell::Cell,
        io::{Read, Write},
        net::TcpListener,
        rc::Rc,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };
    use tao::{
        event::Event,
        event_loop::{ControlFlow, EventLoop},
        platform::run_return::EventLoopExtRunReturn,
        window::WindowBuilder,
    };
    use webview2_com::{
        FindStartCompletedHandler,
        Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment15, ICoreWebView2_28},
        WebMessageReceivedEventHandler,
    };
    use windows_core::{Interface, HSTRING};
    use wry::{WebContext, WebView, WebViewBuilder, WebViewExtWindows};

    fn pump(events: &mut EventLoop<()>) {
        // Drain one complete native message turn, not just the Init event.
        // Exiting on Init leaves Chromium's queued callbacks unserviced.
        events.run_return(|event, _, flow| {
            *flow = ControlFlow::Wait;
            if matches!(event, Event::MainEventsCleared) {
                *flow = ControlFlow::Exit;
            }
        });
        std::thread::sleep(Duration::from_millis(5));
    }
    fn evaluate(events: &mut EventLoop<()>, view: &WebView, js: &str) -> serde_json::Value {
        let result = Arc::new(Mutex::new(None));
        let output = result.clone();
        view.evaluate_script_with_callback(js, move |s| *output.lock().unwrap() = Some(s))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            pump(events);
            if let Some(s) = result.lock().unwrap().take() {
                return serde_json::from_str(&s).unwrap_or(serde_json::Value::String(s));
            }
            assert!(Instant::now() < deadline, "JavaScript/native pump stalled");
        }
    }
    fn wait_for(events: &mut EventLoop<()>, view: &WebView, js: &str) {
        let deadline = Instant::now() + Duration::from_secs(35);
        while evaluate(events, view, js) != true {
            assert!(Instant::now() < deadline, "page readiness timeout: {js}");
            pump(events);
        }
    }
    fn script(source: &'static str, constant: &str) -> &'static str {
        source
            .split_once(constant)
            .unwrap()
            .1
            .split_once("r#\"")
            .unwrap()
            .1
            .split_once("\"#;")
            .unwrap()
            .0
    }

    let server = TcpListener::bind("127.0.0.1:0")?;
    let origin = format!("http://{}", server.local_addr()?);
    std::thread::spawn(move || {
        for stream in server.incoming() {
            let Ok(mut stream) = stream else { break };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            let body = "<!doctype html><title>zro native regression</title><body><h1>Native fixture</h1><script>let ipc=42;window.qaIpcLexical=ipc;window.qaReady=true;window.ipc.postMessage('http-source')</script>";
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
        }
    });
    let profile = std::env::temp_dir().join(format!("zro-native-qa-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&profile)?;
    let file = profile.join("message source.html");
    std::fs::write(&file, "<!doctype html><title>File regression</title><script>window.qaReady=true;chrome.webview.postMessage('file-source')</script>")?;
    let mut events = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("zro hidden regression")
        .with_visible(false)
        .build(&events)?;
    let mut context = WebContext::new(Some(profile.join("webview")));
    let ipc = Rc::new(Cell::new(0));
    let ipc_count = ipc.clone();
    let view = WebViewBuilder::new_with_web_context(&mut context)
        .with_focused(false)
        .with_initialization_script(script(
            include_str!("../src/browser/shields.rs"),
            "const FARBLE_JS",
        ))
        .with_initialization_script(script(
            include_str!("../src/browser/perf.rs"),
            "const PERF_INIT_SCRIPT",
        ))
        .with_ipc_handler(move |_| ipc_count.set(ipc_count.get() + 1))
        .with_url(&origin)
        .build_as_child(&window)?;
    wait_for(&mut events, &view, "window.qaReady===true");
    assert_eq!(evaluate(&mut events, &view, "window.qaIpcLexical"), 42);
    assert!(ipc.get() > 0, "valid HTTP IPC was not delivered");
    println!("PASS page lexical ipc coexists with native IPC bridge");
    let native_messages = Rc::new(Cell::new(0));
    let count = native_messages.clone();
    let raw = WebMessageReceivedEventHandler::create(Box::new(move |_, _| {
        count.set(count.get() + 1);
        Ok(())
    }));
    let mut token = 0;
    unsafe {
        view.webview().add_WebMessageReceived(&raw, &mut token)?;
    }

    for (name, url) in [
        ("file", url::Url::from_file_path(&file).unwrap().to_string()),
        ("data", "data:text/html,<title>Data</title><script>window.qaReady=true;chrome.webview.postMessage('data-source')</script>".into()),
        ("about", "about:blank".into()),
        ("http", origin.clone()),
    ] {
        let before = native_messages.get();
        view.load_url(&url)?;
        if name == "about" {
            wait_for(&mut events, &view, "location.href==='about:blank'");
            evaluate(&mut events, &view, "chrome.webview.postMessage('about-source');true");
        } else {
            wait_for(&mut events, &view, "window.qaReady===true");
        }
        wait_for(&mut events, &view, "document.readyState==='complete'");
        let deadline = Instant::now()+Duration::from_secs(3);
        while native_messages.get()==before && Instant::now()<deadline { pump(&mut events); }
        assert!(native_messages.get()>before, "{name} message was not exercised");
        assert_eq!(evaluate(&mut events,&view,"21*2"),42);
        println!("PASS native IPC survives {name} source");
    }
    evaluate(&mut events, &view, "location.href=URL.createObjectURL(new Blob([\"<script>window.qaReady=true;chrome.webview.postMessage('blob-source')<\\/script>\"],{type:'text/html'}));true");
    wait_for(
        &mut events,
        &view,
        "location.protocol==='blob:'&&window.qaReady===true",
    );
    assert_eq!(evaluate(&mut events, &view, "21*2"), 42);
    println!("PASS native IPC survives blob source");
    assert_eq!(evaluate(&mut events, &view, "(()=>{let c=document.createElement('canvas');c.width=128;c.height=64;let x=c.getContext('2d');x.fillStyle='rgb(127,127,127)';x.fillRect(0,0,128,64);return Array.from(x.getImageData(0,0,128,64).data).every((v,i)=>v===(i%4===3?255:127))})()"),true);
    println!("PASS canvas readback remains exact");

    evaluate(&mut events, &view, "document.body.textContent='';let f=document.createDocumentFragment();for(let i=0;i<30000;i++){let p=document.createElement('p');p.textContent='Every letter e appears here repeatedly '+i;f.append(p)}document.body.append(f);true");
    unsafe {
        let find = view.webview().cast::<ICoreWebView2_28>()?.Find()?;
        let options = view
            .environment()
            .cast::<ICoreWebView2Environment15>()?
            .CreateFindOptions()?;
        options.SetFindTerm(&HSTRING::from("e"))?;
        options.SetSuppressDefaultFindDialog(true)?;
        options.SetShouldHighlightAllMatches(false)?;
        let done = Rc::new(Cell::new(false));
        let ready = done.clone();
        let handler = FindStartCompletedHandler::create(Box::new(move |result| {
            result?;
            ready.set(true);
            Ok(())
        }));
        let start = Instant::now();
        find.Start(&options, &handler)?;
        while !done.get() {
            pump(&mut events);
            assert!(start.elapsed() < Duration::from_secs(20));
        }
        find.Stop()?;
        assert_eq!(evaluate(&mut events, &view, "21*2"), 42);
        println!(
            "PASS native single-letter find in 30,000 paragraphs ({:?})",
            start.elapsed()
        );
    }
    for i in 0..100 {
        view.set_visible(false)?;
        view.set_bounds(wry::Rect {
            position: wry::dpi::PhysicalPosition::new(44, 40).into(),
            size: wry::dpi::PhysicalSize::new(900 + (i % 3), 600).into(),
        })?;
        view.set_visible(true)?;
        unsafe {
            view.controller().NotifyParentWindowPositionChanged()?;
        }
        pump(&mut events);
        if i % 10 == 9 {
            assert_eq!(evaluate(&mut events, &view, "21*2"), 42);
            println!("Native restoration cycle {} responsive", i + 1);
        }
    }
    assert_eq!(evaluate(&mut events, &view, "21*2"), 42);
    println!("PASS 100 native visibility/bounds restoration cycles (not physical Alt-Tab)");

    if std::env::args().any(|a| a == "--live") {
        for url in [
            "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit",
            "https://chat.deepseek.com/",
        ] {
            view.load_url(url)?;
            let start=Instant::now();
            while start.elapsed()<Duration::from_secs(25) { pump(&mut events); }
            let result=evaluate(&mut events,&view,"JSON.stringify({url:location.origin,title:document.title,text:document.body?.innerText.slice(0,700),canvas:document.querySelectorAll('canvas').length,grid:!!document.querySelector('.grid-container,.waffle')})");
            println!("LIVE (inspect; not an authenticated-session assertion): {result}");
        }
    }
    // Keep diagnostics/profile on failure, and never touch the user's profile.
    println!(
        "Native tests completed; isolated profile: {}",
        profile.display()
    );
    Ok(())
}
