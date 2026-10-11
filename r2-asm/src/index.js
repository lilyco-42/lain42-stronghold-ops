// R2 分片装配器：把大对象用 multipart upload 拼出来，绕开 wrangler 的 300 MiB 上传上限。
// 字节不经过这个 Worker——分片先用 `wrangler r2 object put` 落成桶里的小对象，
// 这里只做 create / uploadPart（从桶里读）/ complete，所以没有请求体大小限制的问题。
//
// 所有端点都要 x-asm-token 头；没有它一律 401，避免变成一个公开的写接口。
// 每一步单独一个请求：单请求只搬一片，稳在 Workers 的 CPU 与 100 s 墙钟以内。

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const bad = (msg, status = 400) => json({ error: msg }, status);

export default {
  async fetch(req, env) {
    if (!env.ASM_TOKEN || req.headers.get('x-asm-token') !== env.ASM_TOKEN) {
      return bad('unauthorized', 401);
    }
    const url = new URL(req.url);
    const p = url.searchParams;
    const need = (name) => p.get(name);

    try {
      if (url.pathname === '/health') {
        return json({ ok: true, bucket: 'lain42-dl' });
      }

      if (url.pathname === '/create') {
        const key = need('key');
        if (!key) return bad('缺 key');
        const contentType = need('contentType') || 'application/octet-stream';
        const mpu = await env.BUCKET.createMultipartUpload(key, {
          httpMetadata: { contentType },
        });
        return json({ uploadId: mpu.uploadId, key });
      }

      if (url.pathname === '/part') {
        const key = need('key');
        const uploadId = need('uploadId');
        const part = Number(need('part'));
        const srcKey = need('srcKey');
        if (!key || !uploadId || !Number.isInteger(part) || part < 1 || !srcKey) {
          return bad('参数不全：key, uploadId, part, srcKey');
        }
        const src = await env.BUCKET.get(srcKey);
        if (!src) return bad(`分片对象不存在：${srcKey}`, 404);
        const mpu = await env.BUCKET.resumeMultipartUpload(key, uploadId);
        // uploadPart 返回的是 UploadedPart 对象，不是 etag 字符串——
        // 上一版把它 String() 掉了，complete 直接报 "not of type 'UploadedPart'"。
        const uploaded = await mpu.uploadPart(part, src.body);
        return json({
          part: uploaded && uploaded.part != null ? uploaded.part : part,
          etag: uploaded && uploaded.etag ? uploaded.etag : null,
        });
      }

      if (url.pathname === '/complete') {
        const key = need('key');
        const uploadId = need('uploadId');
        const raw = need('parts');
        if (!key || !uploadId || !raw) return bad('参数不全：key, uploadId, parts');
        const parts = JSON.parse(raw);
        if (!Array.isArray(parts) || !parts.length) return bad('parts 要是非空数组');
        for (const p of parts) {
          if (!Number.isInteger(p.part) || typeof p.etag !== 'string' || !p.etag) {
            return bad(`parts 元素不完整：${JSON.stringify(p)}`);
          }
        }
        // R2MultipartUpload 没有 listParts()（那是 R2Bucket.listMultipartUploads 一类），
        // 而 /part 已经带回真正的 etag，所以由调用方把 [{part, etag}] 传回来。
        const mpu = await env.BUCKET.resumeMultipartUpload(key, uploadId);
        let res;
        try {
          res = await mpu.complete(parts);
        } catch (e) {
          res = await mpu.complete(
            parts.map((x) => x.part),
            parts.map((x) => x.etag),
          );
        }
        return json({
          completed: true,
          key,
          partCount: parts.length,
          object: res && res.key ? res.key : key,
        });
      }

      if (url.pathname === '/assemble') {
        // 整条 multipart 必须在一个请求里做完：complete() 只接受真正的 UploadedPart 实例
        // （传普通 {part, etag} 对象会报 "not of type 'UploadedPart'"），
        // 而 R2MultipartUpload 没有 listParts()，跨请求拿不回这些对象。
        const key = need('key');
        const rawKeys = need('srcKeys');
        if (!key || !rawKeys) return bad('参数不全：key, srcKeys');
        const srcKeys = JSON.parse(rawKeys);
        if (!Array.isArray(srcKeys) || !srcKeys.length) return bad('srcKeys 要是非空数组');
        const contentType = need('contentType') || 'application/octet-stream';
        const mpu = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType } });
        const parts = [];
        try {
          for (let i = 0; i < srcKeys.length; i += 1) {
            const src = await env.BUCKET.get(srcKeys[i]);
            if (!src) throw new Error(`分片对象不存在：${srcKeys[i]}`);
            parts.push(await mpu.uploadPart(i + 1, src.body));
          }
          await mpu.complete(parts);
        } catch (e) {
          try {
            await mpu.abort();
          } catch {}
          throw e;
        }
        return json({
          assembled: true,
          key,
          partCount: parts.length,
          etags: parts.map((p) => p && p.etag),
        });
      }

      if (url.pathname === '/abort') {
        const key = need('key');
        const uploadId = need('uploadId');
        if (!key || !uploadId) return bad('参数不全：key, uploadId');
        await (await env.BUCKET.resumeMultipartUpload(key, uploadId)).abort();
        return json({ aborted: true, key });
      }

      return bad('未知路径', 404);
    } catch (e) {
      return bad(`${e && e.name}: ${e && e.message}`, 500);
    }
  },
};
