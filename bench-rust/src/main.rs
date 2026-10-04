// 用同一批真实 m.public 帧，测 Rust 侧各编码方案的字节数与 CPU。
// 与 bench-encoding.mjs 保持同一套方案，好直接对比「语言的影响」。
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use serde_json::Value;
use std::io::{Read, Write};
use std::time::Instant;

fn json(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).unwrap()
}

fn deflate(data: &[u8], level: u32) -> Vec<u8> {
    let mut e = DeflateEncoder::new(Vec::new(), Compression::new(level));
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

fn inflate(data: &[u8]) -> Vec<u8> {
    let mut d = DeflateDecoder::new(data);
    let mut out = Vec::new();
    d.read_to_end(&mut out).unwrap();
    out
}

fn bench<F, G>(name: &str, frames: &[Value], enc: F, dec: G, bytes: &mut Vec<(String, usize, f64, f64)>, rounds: usize)
where
    F: Fn(&Value) -> Vec<u8>,
    G: Fn(&[u8]) -> Value,
{
    let mut total_bytes = 0usize;
    let mut enc_ms = 0f64;
    let mut dec_ms = 0f64;
    let mut ok = true;

    for _ in 0..rounds {
        let t0 = Instant::now();
        let encoded: Vec<Vec<u8>> = frames.iter().map(|f| enc(f)).collect();
        enc_ms += t0.elapsed().as_secs_f64() * 1000.0;

        let t1 = Instant::now();
        for (i, b) in encoded.iter().enumerate() {
            let back = dec(b);
            if back != frames[i] {
                ok = false;
            }
        }
        dec_ms += t1.elapsed().as_secs_f64() * 1000.0;

        total_bytes = encoded.iter().map(|b| b.len()).sum();
    }

    let n = rounds as f64;
    println!(
        "{:<30}{:>10.1}{:>9.1}{:>9.1}   {}",
        name,
        total_bytes as f64 / 1024.0,
        enc_ms / n,
        dec_ms / n,
        if ok { "✓" } else { "✗ 数据不一致!" }
    );
    bytes.push((name.to_string(), total_bytes, enc_ms / n, dec_ms / n));
}

fn main() {
    let raw = std::fs::read_to_string("ws-frames.json").unwrap();
    let doc: Value = serde_json::from_str(&raw).unwrap();
    let frames: Vec<Value> = doc["frames"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["dir"] == "in" && f["text"] == Value::Bool(true))
        .filter_map(|f| f["payload"].as_str().and_then(|s| serde_json::from_str::<Value>(s).ok()))
        .filter(|v| v["t"] == "m.public")
        .collect();

    println!("载入 m.public 帧: {}\n", frames.len());
    let rounds = 20;

    let mut out = Vec::new();
    println!("{:<30}{:>10}{:>9}{:>9}   {}", "方案", "总字节(KB)", "编码ms", "解码ms", "正确");
    println!("{}", "-".repeat(74));

    bench("JSON（基线）", &frames, |f| json(f), |b| serde_json::from_slice(b).unwrap(), &mut out, rounds);
    bench("JSON + deflate(1)", &frames, |f| deflate(&json(f), 1), |b| serde_json::from_slice(&inflate(b)).unwrap(), &mut out, rounds);
    bench("JSON + deflate(6)", &frames, |f| deflate(&json(f), 6), |b| serde_json::from_slice(&inflate(b)).unwrap(), &mut out, rounds);
    bench("MessagePack", &frames, |f| rmp_serde::to_vec(f).unwrap(), |b| rmp_serde::from_slice(b).unwrap(), &mut out, rounds);
    bench("MessagePack + deflate(1)", &frames,
        |f| deflate(&rmp_serde::to_vec(f).unwrap(), 1),
        |b| rmp_serde::from_slice(&inflate(b)).unwrap(), &mut out, rounds);

    println!("\n（{} 轮平均；总字节是单轮 86 帧合计）", rounds);
}
