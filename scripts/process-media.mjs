import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FALLBACK_WHATSAPP_TOKEN =
  'WAAVjrWGKzhSIZBI9qvtV7IXgYftKEcSeSikSIuKPhSMNBCXPaMIvjYAXrsiTzfM1WaM4v09TsGKZBsUTc22qnsarm4cGfIZCdbQajxmwfFiYr3pP3FGRaZCmlNjcYG3R0ui8G6pxm8ZCWtoBI8TTSG3cGi6C4klAfi3794431ZBpGflzZAEZD';
const FALLBACK_WORKER_CALLBACK_URL =
  'https://whatsapp-media-agent.mnipass-wa-agent.workers.dev/api/job-callback';
const FALLBACK_CALLBACK_SECRET = 'c1ecad4ccdc12f00d3b89119832dc3dd2e1fc31c426662a2';

const WHATSAPP_API_BASE = 'https://api.whatsapp.com/agent/v1';
const WHATSAPP_TOKEN = (process.env.WHATSAPP_ACCESS_TOKEN || FALLBACK_WHATSAPP_TOKEN).trim();

// WhatsApp Agent Platform hard upload limit is 16 MB (16,777,216 bytes; we enforce <= 15.8 MB to be 100% safe)
const HARD_MAX_BYTES = 15_900_000;
const TARGET_BUDGET_BYTES = 15_100_000; // ~15.1 MB target leaves headroom for MP4 moov atom & container overhead

const EROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function parseJobPayload() {
  let payload = {};
  if (process.env.PAYLOAD_JSON && process.env.PAYLOAD_JSON !== 'null') {
    try {
      payload = JSON.parse(process.env.PAYLOAD_JSON);
    } catch {
      payload = {};
    }
  }

  return {
    job_id: payload.job_id || process.env.INPUT_JOB_ID || `gh_${Date.now()}`,
    to: payload.to || process.env.INPUT_TO || '',
    mode: payload.mode || process.env.INPUT_MODE || 'video',
    source: payload.source || 'youtube',
    video_url: payload.video_url || process.env.INPUT_VIDEO_URL || '',
    referer_url: payload.referer_url || '',
    title: payload.title || '',
    quality: payload.quality || process.env.INPUT_QUALITY || 'auto',
    query: payload.query || '',
    sort: payload.sort === 'recent' ? 'recent' : 'top',
    force: Boolean(payload.force),
    page: Number(payload.page || 1),
    seen_urls: Array.isArray(payload.seen_urls) ? payload.seen_urls : [],
    reply_to_wamid: payload.reply_to_wamid || undefined,
    callback_url:
      payload.callback_url || process.env.WORKER_CALLBACK_URL || FALLBACK_WORKER_CALLBACK_URL,
  };
}

function runCmd(bin, args, allowFailure = false) {
  const res = spawnSync(bin, args, { stdio: 'inherit' });
  if (res.status !== 0 && !allowFailure) {
    throw new Error(`${bin} exited with code ${res.status}`);
  }
  return res.status === 0;
}

function probeMedia(filePath) {
  const raw = execFileSync('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]).toString('utf8');

  const info = JSON.parse(raw);
  const durationSec = Math.max(1, Number(info.format?.duration || 0));
  const sizeBytes = fs.statSync(filePath).size;
  const videoStream = (info.streams || []).find((s) => s.codec_type === 'video');
  const audioStream = (info.streams || []).find((s) => s.codec_type === 'audio');

  return {
    durationSec,
    sizeBytes,
    vcodec: videoStream?.codec_name || '',
    vprofile: videoStream?.profile || '',
    hasBFrames: Number(videoStream?.has_b_frames || 0) > 0,
    width: Number(videoStream?.width || 0),
    height: Number(videoStream?.height || 0),
    acodec: audioStream?.codec_name || '',
  };
}

function selectAdaptiveScaleAndFps(videoBitrateBps, qualityPref) {
  let maxHeight = 720;
  let fpsFilter = '';

  if (qualityPref === '360p') {
    maxHeight = 360;
  } else if (qualityPref === '480p') {
    maxHeight = 480;
  }

  if (videoBitrateBps < 80_000) {
    maxHeight = Math.min(maxHeight, 144);
    fpsFilter = ',fps=15';
  } else if (videoBitrateBps < 160_000) {
    maxHeight = Math.min(maxHeight, 240);
    fpsFilter = ',fps=20';
  } else if (videoBitrateBps < 340_000) {
    maxHeight = Math.min(maxHeight, 360);
    fpsFilter = ',fps=24';
  } else if (videoBitrateBps < 750_000) {
    maxHeight = Math.min(maxHeight, 480);
  }

  return `scale=-2:'min(${maxHeight},ih)'${fpsFilter}`;
}

function encodeTwoPassVideo(inputPath, outputPath, durationSec, targetBytes, qualityPref) {
  const totalBitsPerSec = Math.floor((targetBytes * 8 * 0.93) / durationSec);
  const audioBps = durationSec <= 300 ? 96_000 : durationSec <= 900 ? 64_000 : 48_000;
  const audioChannels = audioBps <= 64_000 ? '1' : '2';
  const videoBps = Math.max(36_000, totalBitsPerSec - audioBps);

  const vf = selectAdaptiveScaleAndFps(videoBps, qualityPref);
  const passLog = path.join(path.dirname(outputPath), 'ffmpeg2pass');

  console.log(
    `Relative compression: duration=${durationSec.toFixed(1)}s, target=${(targetBytes / 1e6).toFixed(2)}MB, video=${Math.round(videoBps / 1000)}kbps, audio=${Math.round(audioBps / 1000)}kbps, vf="${vf}"`
  );

  // Pass 1 (H.264 Main without B-frames for maximum WhatsApp compatibility per manual)
  runCmd('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    '-c:v',
    'libx264',
    '-profile:v',
    'main',
    '-bf',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    String(videoBps),
    '-maxrate',
    String(Math.round(videoBps * 1.15)),
    '-bufsize',
    String(Math.round(videoBps * 2)),
    '-vf',
    vf,
    '-pass',
    '1',
    '-passlogfile',
    passLog,
    '-an',
    '-f',
    'mp4',
    '/dev/null',
  ]);

  // Pass 2 with AAC audio and +faststart moov atom
  runCmd('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    '-c:v',
    'libx264',
    '-profile:v',
    'main',
    '-bf',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    String(videoBps),
    '-maxrate',
    String(Math.round(videoBps * 1.15)),
    '-bufsize',
    String(Math.round(videoBps * 2)),
    '-vf',
    vf,
    '-pass',
    '2',
    '-passlogfile',
    passLog,
    '-c:a',
    'aac',
    '-b:a',
    String(audioBps),
    '-ac',
    audioChannels,
    '-movflags',
    '+faststart',
    outputPath,
  ]);
}

async function sendWhatsAppText(to, body, replyToWamid) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: body.slice(0, 4096), preview_url: false },
  };
  if (replyToWamid) {
    payload.context = { message_id: replyToWamid };
  }
  const res = await fetch(`${WHATSAPP_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error('WhatsApp text send failed:', res.status, await res.text());
  }
}

async function uploadAndSendWhatsAppMedia(to, filePath, mimeType, mediaType, caption, replyToWamid) {
  const bytes = fs.readFileSync(filePath);
  const blob = new Blob([bytes], { type: mimeType });
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', blob, path.basename(filePath));

  const uploadRes = await fetch(`${WHATSAPP_API_BASE}/media`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: form,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`WhatsApp media upload HTTP ${uploadRes.status}: ${errText}`);
  }

  const { id: mediaId } = await uploadRes.json();
  const msgPayload = {
    messaging_product: 'whatsapp',
    to,
    type: mediaType,
    [mediaType]:
      mediaType === 'audio'
        ? { id: mediaId }
        : { id: mediaId, caption: caption.slice(0, 1024) },
  };
  if (replyToWamid) {
    msgPayload.context = { message_id: replyToWamid };
  }

  const sendRes = await fetch(`${WHATSAPP_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify(msgPayload),
  });

  if (!sendRes.ok) {
    const errText = await sendRes.text();
    throw new Error(`WhatsApp media message HTTP ${sendRes.status}: ${errText}`);
  }

  return mediaId;
}

async function reportCallback(job, data) {
  if (!job.callback_url) return;
  const secret = (process.env.CALLBACK_SECRET || FALLBACK_CALLBACK_SECRET).trim();
  const headers = { 'Content-Type': 'application/json' };
  if (secret) {
    headers.Authorization = `Bearer ${secret}`;
  }
  try {
    await fetch(job.callback_url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ job_id: job.job_id, ...data }),
    });
  } catch (err) {
    console.warn('Callback warning:', err.message);
  }
}

function isWarpReady() {
  return Boolean(process.env.WARP_PROXY && fs.existsSync('/tmp/warp_ready'));
}

function buildYtDlpBaseArgs(clientSpec, useCookies = true, proxyUrl = null) {
  const args = ['-v', '--js-runtimes', 'deno', '--remote-components', 'ejs:github'];
  if (proxyUrl) {
    args.push('--proxy', proxyUrl);
  }
  args.push('--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416');
  if (clientSpec) {
    args.push('--extractor-args', `youtube:player_client=${clientSpec}`);
  }

  if (useCookies && process.env.YT_COOKIES?.trim()) {
    const cookiePath = '/tmp/yt_cookies.txt';
    fs.writeFileSync(cookiePath, process.env.YT_COOKIES.trim(), 'utf8');
    args.push('--cookies', cookiePath);
  }
  return args;
}

function runYtDlpWithRetry(ytArgs) {
  const warpProxy = isWarpReady() ? process.env.WARP_PROXY : null;
  const attempts = [];
  if (warpProxy) {
    attempts.push(
      { client: null, cookies: false, proxy: warpProxy },
      { client: 'tv_simply,android_vr', cookies: false, proxy: warpProxy },
      { client: 'ios,web_safari', cookies: false, proxy: warpProxy },
      { client: 'tv,web_safari', cookies: true, proxy: warpProxy }
    );
  }
  attempts.push(
    { client: 'tv,web_safari', cookies: true, proxy: null },
    { client: null, cookies: true, proxy: null },
    { client: 'tv_simply,android_vr', cookies: false, proxy: null }
  );

  for (let i = 0; i < attempts.length; i++) {
    const { client, cookies, proxy } = attempts[i];
    const base = buildYtDlpBaseArgs(client, cookies, proxy);
    const ok = runCmd('yt-dlp', [...base, ...ytArgs], i < attempts.length - 1);
    if (ok) return;
    console.warn(
      `yt-dlp attempt ${i + 1} (client=${client || 'default'}, cookies=${cookies}, proxy=${proxy ? 'warp' : 'direct'}) failed, trying next fallback...`
    );
  }
  throw new Error('yt-dlp exited with code 1 across all player clients');
}

function isEromeHost(urlStr) {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return host === 'erome.com' || host.endsWith('.erome.com');
  } catch {
    return false;
  }
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function curlFetchText(url, referer = 'https://www.erome.com/') {
  const attempts = [null];
  if (isWarpReady()) attempts.push('127.0.0.1:40000');

  for (const socks of attempts) {
    try {
      const args = [
        '-fsSL',
        '--max-time',
        '25',
        '-A',
        EROME_USER_AGENT,
        '-e',
        referer,
        '-H',
        'Accept-Language: en-US,en;q=0.9',
      ];
      if (socks) args.push('--socks5-hostname', socks);
      args.push(url);
      const html = execFileSync('curl', args, { maxBuffer: 12 * 1024 * 1024 }).toString('utf8');
      if (html && !html.includes('cf-browser-verification') && !html.includes('Just a moment...')) {
        return html;
      }
    } catch {
      // try next
    }
  }
  return null;
}

function curlProbeSize(url, referer = 'https://www.erome.com/') {
  const attempts = [null];
  if (isWarpReady()) attempts.push('127.0.0.1:40000');

  for (const socks of attempts) {
    try {
      const args = ['-sIL', '--max-time', '15', '-A', EROME_USER_AGENT, '-e', referer];
      if (socks) args.push('--socks5-hostname', socks);
      args.push(url);
      const headers = execFileSync('curl', args).toString('utf8');
      const matches = [...headers.matchAll(/content-length:\s*(\d+)/gi)];
      if (matches.length > 0) {
        const len = Number(matches[matches.length - 1][1]);
        if (Number.isFinite(len) && len > 0) return len;
      }
    } catch {
      // try next
    }
  }
  return null;
}

function curlDownloadFile(url, referer, outPath) {
  const attempts = [null];
  if (isWarpReady()) attempts.push('127.0.0.1:40000');

  for (const socks of attempts) {
    const args = [
      '-fSL',
      '--max-time',
      '240',
      '-A',
      EROME_USER_AGENT,
      '-e',
      referer || 'https://www.erome.com/',
      '-o',
      outPath,
    ];
    if (socks) args.push('--socks5-hostname', socks);
    args.push(url);
    if (runCmd('curl', args, true) && fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000) {
      return true;
    }
  }
  return false;
}

function parseEromeSearchHtml(html) {
  const results = [];
  const seen = new Set();
  const blockRegex = /<div[^>]*class="[^"]*\balbum\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\balbum\b[^"]*"|<footer|<ul[^>]*class="[^"]*pagination|$)/gi;
  let bm;
  while ((bm = blockRegex.exec(html)) !== null) {
    const block = bm[1];
    const urlMatch = block.match(/https?:\/\/(?:www\.)?erome\.com\/a\/([a-zA-Z0-9]+)/i);
    if (!urlMatch) continue;
    const albumId = urlMatch[1];
    if (seen.has(albumId)) continue;
    seen.add(albumId);

    const titleMatch =
      block.match(/class="[^"]*album-title[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/alt="([^"]{2,160})"/i);
    const title = titleMatch?.[1]
      ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, ''))
      : `Erome Album ${albumId}`;

    const userMatch = block.match(/class="[^"]*album-user[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const uploader = userMatch?.[1]
      ? decodeHtmlEntities(userMatch[1].replace(/<[^>]+>/g, ''))
      : 'Erome';

    const dataSrc = block.match(/data-src="(https?:\/\/[^"]+)"/i)?.[1];
    const src = block.match(/<img[^>]+src="(https?:\/\/[^"]+)"/i)?.[1];
    const rawThumb = dataSrc || src;
    const thumbnailUrl =
      rawThumb && !/blank|loading|logo|favicon|\.svg/i.test(rawThumb) ? rawThumb : undefined;

    const videoBadge = block.match(/class="[^"]*album-videos[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const hasZeroVideosHint = Boolean(videoBadge && !/[1-9]/.test(videoBadge[1]) && /\b0\b/.test(videoBadge[1]));

    results.push({
      albumId,
      albumUrl: `https://www.erome.com/a/${albumId}`,
      title: title || `Erome Album ${albumId}`,
      uploader: uploader || 'Erome',
      thumbnailUrl,
      hasZeroVideosHint,
    });
  }

  const urlRegex = /https?:\/\/(?:www\.)?erome\.com\/a\/([a-zA-Z0-9]+)/gi;
  let m;
  while ((m = urlRegex.exec(html)) !== null) {
    const albumId = m[1];
    if (!seen.has(albumId)) {
      seen.add(albumId);
      results.push({
        albumId,
        albumUrl: `https://www.erome.com/a/${albumId}`,
        title: `Erome Album ${albumId}`,
        uploader: 'Erome',
      });
    }
  }
  return results;
}

function parseEromeAlbumHtml(html, albumUrl) {
  const idMatch = albumUrl.match(/\/a\/([a-zA-Z0-9]+)/i);
  const albumId = idMatch?.[1] || 'album';
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const h1Title = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, '');
  const htmlTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = decodeHtmlEntities((ogTitle || h1Title || htmlTitle || `Erome ${albumId}`).replace(/\s*-\s*EroMe\s*$/i, ''));

  const userMatch =
    html.match(/id=["']user_name["'][^>]*>([\s\S]*?)<\//i) ||
    html.match(/class=["'][^"]*user-profile[^"]*["'][^>]*>([\s\S]*?)<\/a>/i) ||
    html.match(/class=["'][^"]*album-user[^"]*["'][^>]*>([\s\S]*?)<\//i);
  const uploader = userMatch?.[1] ? decodeHtmlEntities(userMatch[1].replace(/<[^>]+>/g, '')) : 'Erome';
  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1];

  const videos = [];
  const seenMp4 = new Set();
  const videoBlockRegex = /<video\b([^>]*)>([\s\S]*?)<\/video>/gi;
  let vm;
  while ((vm = videoBlockRegex.exec(html)) !== null) {
    const attrs = vm[1];
    const inner = vm[2];
    const poster = attrs.match(/(?:data-poster|poster)=["'](https?:\/\/[^"']+)["']/i)?.[1] || ogImage;
    const srcMatch =
      inner.match(/<source[^>]+src=["'](https:\/\/[a-zA-Z0-9.-]+\.erome\.com\/[^"']+\.mp4[^"']*)["']/i) ||
      attrs.match(/src=["'](https:\/\/[a-zA-Z0-9.-]+\.erome\.com\/[^"']+\.mp4[^"']*)["']/i);
    if (srcMatch?.[1] && !seenMp4.has(srcMatch[1])) {
      seenMp4.add(srcMatch[1]);
      videos.push({ mp4Url: srcMatch[1], thumbnailUrl: poster });
    }
  }

  const mediaRegex = /https:\/\/[a-zA-Z0-9.-]+\.erome\.com\/[a-zA-Z0-9/_.-]+\.(?:jpg|jpeg|png|webp|mp4)/gi;
  const images = [];
  let mm;
  while ((mm = mediaRegex.exec(html)) !== null) {
    const u = mm[0];
    if (/\.mp4$/i.test(u)) {
      if (!seenMp4.has(u)) {
        seenMp4.add(u);
        videos.push({ mp4Url: u, thumbnailUrl: ogImage });
      }
    } else if (!/logo|avatar|icon|thumb_placeholder/i.test(u)) {
      images.push(u);
    }
  }

  for (const v of videos) {
    if (!v.thumbnailUrl && images.length > 0) v.thumbnailUrl = images[0];
  }

  return { albumId, albumUrl, title, uploader, videos };
}

async function processAndSendVideoFile(job, workDir, sourceFile, videoTitle, originalUrlForFallback) {
  const meta = probeMedia(sourceFile);
  const outMp4 = path.join(workDir, 'whatsapp_ready.mp4');

  const alreadyCompliant =
    meta.sizeBytes <= 15_400_000 &&
    meta.vcodec === 'h264' &&
    !meta.hasBFrames &&
    meta.acodec === 'aac';

  if (alreadyCompliant) {
    runCmd('ffmpeg', ['-y', '-i', sourceFile, '-c', 'copy', '-movflags', '+faststart', outMp4]);
  } else {
    encodeTwoPassVideo(sourceFile, outMp4, meta.durationSec, TARGET_BUDGET_BYTES, job.quality);

    let outSize = fs.statSync(outMp4).size;
    if (outSize > HARD_MAX_BYTES) {
      console.log(`Overshoot (${(outSize / 1e6).toFixed(2)} MB > 15.9 MB). Retrying tighter relative pass...`);
      const tighterBudget = Math.floor(TARGET_BUDGET_BYTES * (TARGET_BUDGET_BYTES / outSize) * 0.88);
      const retryMp4 = path.join(workDir, 'whatsapp_retry.mp4');
      encodeTwoPassVideo(sourceFile, retryMp4, meta.durationSec, tighterBudget, job.quality);
      fs.renameSync(retryMp4, outMp4);
    }
  }

  const finalBytes = fs.statSync(outMp4).size;
  if (finalBytes > HARD_MAX_BYTES) {
    await sendWhatsAppText(
      job.to,
      `Video "${videoTitle}" is too long (${Math.round(meta.durationSec / 60)} min) to fit in a 16 MB MP4 upload even at minimum bitrate.\nWatch directly: ${originalUrlForFallback}`,
      job.reply_to_wamid
    );
    await reportCallback(job, {
      status: 'too_long_fallback',
      title: videoTitle,
      source_size_bytes: meta.sizeBytes,
      compressed_size_bytes: finalBytes,
      duration_sec: Math.round(meta.durationSec),
      error_message: 'Duration exceeds minimum viable 16 MB MP4 bitrate',
    });
    return;
  }

  const origMb = (meta.sizeBytes / 1e6).toFixed(1);
  const finalMb = (finalBytes / 1e6).toFixed(2);
  const caption =
    alreadyCompliant && meta.sizeBytes <= HARD_MAX_BYTES
      ? `${videoTitle}\n${finalMb} MB (under WhatsApp 16 MB limit)`
      : `${videoTitle}\nCompressed ${origMb} MB -> ${finalMb} MB (WhatsApp 16 MB limit)`;

  const mediaId = await uploadAndSendWhatsAppMedia(
    job.to,
    outMp4,
    'video/mp4',
    'video',
    caption,
    job.reply_to_wamid
  );

  await reportCallback(job, {
    status: 'completed',
    title: videoTitle,
    source_size_bytes: meta.sizeBytes,
    compressed_size_bytes: finalBytes,
    duration_sec: Math.round(meta.durationSec),
    media_id: mediaId,
  });
}

async function main() {
  const job = parseJobPayload();
  if (!job.to || !job.to.startsWith('user:')) {
    throw new Error(`Invalid or missing recipient "to": "${job.to}"`);
  }

  const workDir = fs.mkdtempSync('/tmp/wa-media-');

  try {
    if (job.mode === 'emsearch') {
      const seenSet = new Set(job.seen_urls || []);
      const collected = [];
      let currentPage = Math.max(1, job.page || 1);

      for (let offset = 0; offset < 6 && collected.length < 5; offset++) {
        currentPage = Math.max(1, job.page || 1) + offset;
        const sortParam = job.sort === 'recent' ? '&o=new' : '';
        const searchUrl = `https://www.erome.com/search?q=${encodeURIComponent(job.query)}${sortParam}&page=${currentPage}`;
        const html = curlFetchText(searchUrl, 'https://www.erome.com/');
        if (!html) break;

        const albums = parseEromeSearchHtml(html).filter((a) => !a.hasZeroVideosHint);
        if (!albums.length) break;

        for (const album of albums) {
          if (collected.length >= 5) break;
          const albumHtml = curlFetchText(album.albumUrl, searchUrl);
          if (!albumHtml) continue;
          const parsed = parseEromeAlbumHtml(albumHtml, album.albumUrl);
          if (!parsed.videos.length) continue;

          for (let vIdx = 0; vIdx < parsed.videos.length; vIdx++) {
            if (collected.length >= 5) break;
            const vid = parsed.videos[vIdx];
            if (seenSet.has(vid.mp4Url)) continue;

            const sizeBytes = curlProbeSize(vid.mp4Url, album.albumUrl);
            if (!job.force) {
              if (!sizeBytes || sizeBytes < 51_200 || sizeBytes > HARD_MAX_BYTES) {
                seenSet.add(vid.mp4Url);
                continue;
              }
            }

            seenSet.add(vid.mp4Url);
            const sizeLabel = sizeBytes
              ? sizeBytes > HARD_MAX_BYTES
                ? `${(sizeBytes / 1e6).toFixed(1)} MB (compress)`
                : `${(sizeBytes / 1e6).toFixed(1)} MB`
              : 'MP4';

            collected.push({
              videoId: `erome_${parsed.albumId}_${vIdx + 1}`,
              title: parsed.videos.length > 1 ? `${parsed.title} (#${vIdx + 1})` : parsed.title,
              channel: parsed.uploader || album.uploader || 'Erome',
              duration: sizeLabel,
              url: vid.mp4Url,
              source: 'erome',
              referer_url: album.albumUrl,
              thumbnail_url: vid.thumbnailUrl || album.thumbnailUrl,
              size_bytes: sizeBytes,
            });
            break;
          }
        }
      }

      if (!collected.length) {
        await sendWhatsAppText(
          job.to,
          job.force
            ? `No videos found on Erome for "${job.query}".`
            : `No videos under 16 MB found on Erome for "${job.query}". Try /emsearch ${job.query} ${job.sort} force to include larger videos with compression.`,
          job.reply_to_wamid
        );
        return;
      }

      await reportCallback(job, {
        user_id: job.to,
        query: job.query,
        search_results: collected,
        erome_state: {
          query: job.query,
          sort_mode: job.sort,
          force_mode: job.force,
          current_page: currentPage,
          seen_urls: Array.from(seenSet).slice(-120),
        },
      });

      for (let i = 0; i < collected.length; i++) {
        const item = collected[i];
        const captionLines = [
          `*${i + 1}. ${item.title}*`,
          `[Erome · ${job.sort === 'recent' ? 'Recent' : 'Top'}${job.force ? ' · Force' : ''}] · ${item.channel} · ${item.duration}`,
          item.referer_url,
          '',
          `Quick: /play ${i + 1} · /audio ${i + 1} · /info ${i + 1} · /queue add ${i + 1}`,
        ];
        if (i === collected.length - 1) {
          captionLines.push('Tip: Send /more for the next 5 results.');
        }
        const caption = captionLines.join('\n');
        const quoteId = i === 0 ? job.reply_to_wamid : undefined;

        const thumbPath = path.join(workDir, `erome_thumb_${i + 1}.jpg`);
        if (item.thumbnail_url && curlDownloadFile(item.thumbnail_url, item.referer_url, thumbPath)) {
          try {
            await uploadAndSendWhatsAppMedia(job.to, thumbPath, 'image/jpeg', 'image', caption, quoteId);
            continue;
          } catch {
            // fallback to text
          }
        }
        await sendWhatsAppText(job.to, caption, quoteId);
      }
      return;
    }

    if (job.mode === 'emrandom') {
      const randomPage = Math.floor(Math.random() * 6) + 1;
      const listingUrl = job.query
        ? `https://www.erome.com/search?q=${encodeURIComponent(job.query)}&page=${Math.floor(Math.random() * 3) + 1}`
        : `https://www.erome.com/${Math.random() < 0.5 ? 'explore' : 'explore/new'}?page=${randomPage}`;
      const listHtml = curlFetchText(listingUrl, 'https://www.erome.com/');
      if (!listHtml) {
        throw new Error('Could not reach Erome explore listing');
      }

      const albums = parseEromeSearchHtml(listHtml).filter((a) => !a.hasZeroVideosHint);
      for (let i = albums.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [albums[i], albums[j]] = [albums[j], albums[i]];
      }

      let picked = null;
      for (const album of albums.slice(0, 16)) {
        const albumHtml = curlFetchText(album.albumUrl, listingUrl);
        if (!albumHtml) continue;
        const parsed = parseEromeAlbumHtml(albumHtml, album.albumUrl);
        for (const vid of parsed.videos) {
          const sizeBytes = curlProbeSize(vid.mp4Url, album.albumUrl);
          if (sizeBytes && sizeBytes >= 51_200 && sizeBytes <= HARD_MAX_BYTES) {
            picked = {
              mp4Url: vid.mp4Url,
              albumUrl: album.albumUrl,
              title: parsed.title || album.title,
            };
            break;
          }
        }
        if (picked) break;
      }

      if (!picked) {
        throw new Error('No random video under 16 MB found across sampled albums');
      }

      const sourceFile = path.join(workDir, 'source.mp4');
      if (!curlDownloadFile(picked.mp4Url, picked.albumUrl, sourceFile)) {
        throw new Error(`Failed downloading random video from ${picked.albumUrl}`);
      }

      await processAndSendVideoFile(job, workDir, sourceFile, picked.title, picked.albumUrl);
      return;
    }

    if (job.mode === 'search') {
      const searchJson = execFileSync('yt-dlp', [
        ...buildYtDlpBaseArgs(null),
        '--dump-json',
        '--flat-playlist',
        `ytsearch5:${job.query}`,
      ]).toString('utf8');

      const entries = searchJson
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      if (!entries.length) {
        await sendWhatsAppText(job.to, `No results found for "${job.query}".`, job.reply_to_wamid);
        return;
      }

      await reportCallback(job, {
        user_id: job.to,
        query: job.query,
        search_results: entries.map((e) => ({
          videoId: e.id,
          title: e.title || 'Untitled',
          channel: e.channel || e.uploader || 'YouTube',
          duration: e.duration_string || 'N/A',
          url: `https://www.youtube.com/watch?v=${e.id}`,
        })),
      });

      const thumbFiles = await Promise.all(
        entries.map(async (e, i) => {
          try {
            let imgRes = await fetch(`https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`);
            if (!imgRes.ok) {
              imgRes = await fetch(`https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`);
            }
            if (!imgRes.ok) return null;
            const buf = Buffer.from(await imgRes.arrayBuffer());
            const imgPath = path.join(workDir, `thumb_${i + 1}.jpg`);
            fs.writeFileSync(imgPath, buf);
            return imgPath;
          } catch {
            return null;
          }
        })
      );

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const metaLine = [
          e.channel || e.uploader || 'YouTube',
          e.duration_string || 'N/A',
          e.view_count ? `${Number(e.view_count).toLocaleString('en-US')} views` : null,
        ]
          .filter(Boolean)
          .join(' · ');

        const caption = [
          `*${i + 1}. ${e.title || 'Untitled'}*`,
          metaLine,
          `https://www.youtube.com/watch?v=${e.id}`,
          '',
          `Quick: /play ${i + 1} · /audio ${i + 1} · /info ${i + 1} · /queue add ${i + 1}`,
        ].join('\n');

        const quoteId = i === 0 ? job.reply_to_wamid : undefined;
        if (thumbFiles[i]) {
          try {
            await uploadAndSendWhatsAppMedia(
              job.to,
              thumbFiles[i],
              'image/jpeg',
              'image',
              caption,
              quoteId
            );
            continue;
          } catch {
            // fallback to text
          }
        }
        await sendWhatsAppText(job.to, caption, quoteId);
      }
      return;
    }

    if (!job.video_url) {
      throw new Error('Missing video_url in payload');
    }

    const isEromeJob = job.source === 'erome' || isEromeHost(job.video_url);
    let downloadUrl = job.video_url;
    let refererUrl = job.referer_url || 'https://www.erome.com/';
    let videoTitle = job.title;

    if (isEromeJob) {
      if (/erome\.com\/a\/[a-zA-Z0-9]+/i.test(job.video_url)) {
        const albumHtml = curlFetchText(job.video_url, 'https://www.erome.com/');
        if (!albumHtml) throw new Error(`Could not fetch Erome album ${job.video_url}`);
        const parsed = parseEromeAlbumHtml(albumHtml, job.video_url);
        if (!parsed.videos.length) throw new Error(`No MP4 video found in album ${job.video_url}`);
        downloadUrl = parsed.videos[0].mp4Url;
        refererUrl = job.video_url;
        if (!videoTitle) videoTitle = parsed.title;
      }
      if (!videoTitle) videoTitle = 'Erome Media';

      const sourceFile = path.join(workDir, 'source.mp4');
      if (!curlDownloadFile(downloadUrl, refererUrl, sourceFile)) {
        throw new Error(`Failed downloading Erome media from ${downloadUrl}`);
      }

      if (job.mode === 'audio') {
        const meta = probeMedia(sourceFile);
        const maxAudioBps = Math.floor((TARGET_BUDGET_BYTES * 8 * 0.94) / meta.durationSec);
        const chosenKbps = Math.min(192, Math.max(32, Math.floor(maxAudioBps / 1000)));
        const outMp3 = path.join(workDir, 'output.mp3');

        runCmd('ffmpeg', ['-y', '-i', sourceFile, '-vn', '-c:a', 'libmp3lame', '-b:a', `${chosenKbps}k`, outMp3]);
        const finalBytes = fs.statSync(outMp3).size;
        if (finalBytes > HARD_MAX_BYTES) {
          throw new Error(`Compressed audio (${finalBytes} bytes) exceeds 16 MB limit`);
        }

        const mediaId = await uploadAndSendWhatsAppMedia(job.to, outMp3, 'audio/mpeg', 'audio', '', job.reply_to_wamid);
        await sendWhatsAppText(
          job.to,
          `Sent audio: ${videoTitle} (${(finalBytes / 1e6).toFixed(2)} MB @ ${chosenKbps} kbps)`,
          job.reply_to_wamid
        );
        await reportCallback(job, {
          status: 'completed',
          title: videoTitle,
          source_size_bytes: meta.sizeBytes,
          compressed_size_bytes: finalBytes,
          duration_sec: Math.round(meta.durationSec),
          media_id: mediaId,
        });
        return;
      }

      await processAndSendVideoFile(job, workDir, sourceFile, videoTitle, refererUrl || downloadUrl);
      return;
    }

    // YouTube pipeline (existing functionality)
    if (!videoTitle) {
      try {
        const oembedRes = await fetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(job.video_url)}&format=json`
        );
        if (oembedRes.ok) {
          const oembed = await oembedRes.json();
          videoTitle = String(oembed.title || '').trim();
        }
      } catch {
        // fallback below
      }
      if (!videoTitle) {
        try {
          videoTitle = execFileSync('yt-dlp', [
            ...buildYtDlpBaseArgs(null, true),
            '--get-title',
            '--no-playlist',
            job.video_url,
          ])
            .toString('utf8')
            .trim();
        } catch {
          videoTitle = 'YouTube Media';
        }
      }
    }

    if (job.mode === 'audio') {
      const rawAudioTemplate = path.join(workDir, 'source.%(ext)s');
      runYtDlpWithRetry([
        '-f',
        'bestaudio/best',
        '--no-playlist',
        '--max-filesize',
        '300M',
        '-o',
        rawAudioTemplate,
        job.video_url,
      ]);

      const sourceFile = fs
        .readdirSync(workDir)
        .map((f) => path.join(workDir, f))
        .find((f) => path.basename(f).startsWith('source.'));

      if (!sourceFile) throw new Error('Audio download failed');
      const meta = probeMedia(sourceFile);

      // Compute relative audio bitrate so MP3 always stays under 15.5 MB
      const maxAudioBps = Math.floor((TARGET_BUDGET_BYTES * 8 * 0.94) / meta.durationSec);
      const chosenKbps = Math.min(192, Math.max(32, Math.floor(maxAudioBps / 1000)));
      const outMp3 = path.join(workDir, 'output.mp3');

      runCmd('ffmpeg', [
        '-y',
        '-i',
        sourceFile,
        '-vn',
        '-c:a',
        'libmp3lame',
        '-b:a',
        `${chosenKbps}k`,
        outMp3,
      ]);

      const finalBytes = fs.statSync(outMp3).size;
      if (finalBytes > HARD_MAX_BYTES) {
        throw new Error(`Compressed audio (${finalBytes} bytes) still exceeds 16 MB limit`);
      }

      const mediaId = await uploadAndSendWhatsAppMedia(
        job.to,
        outMp3,
        'audio/mpeg',
        'audio',
        '',
        job.reply_to_wamid
      );

      await sendWhatsAppText(
        job.to,
        `Sent audio: ${videoTitle} (${(finalBytes / 1e6).toFixed(2)} MB @ ${chosenKbps} kbps)`,
        job.reply_to_wamid
      );

      await reportCallback(job, {
        status: 'completed',
        source_size_bytes: meta.sizeBytes,
        compressed_size_bytes: finalBytes,
        duration_sec: Math.round(meta.durationSec),
        media_id: mediaId,
      });
      return;
    }

    // YouTube Video mode with relative two-pass compression strictly < 16 MB
    const rawTemplate = path.join(workDir, 'source.%(ext)s');
    runYtDlpWithRetry([
      '-f',
      'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
      '--merge-output-format',
      'mp4',
      '--no-playlist',
      '--max-filesize',
      '600M',
      '-o',
      rawTemplate,
      job.video_url,
    ]);

    const sourceFile = fs
      .readdirSync(workDir)
      .map((f) => path.join(workDir, f))
      .find((f) => path.basename(f).startsWith('source.'));

    if (!sourceFile) throw new Error('Video download failed');

    await processAndSendVideoFile(job, workDir, sourceFile, videoTitle, job.video_url);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Job failed:', errMsg);
    await sendWhatsAppText(
      job.to,
      `Sorry, media processing failed for ${job.video_url || job.query || job.mode}: ${errMsg.slice(0, 200)}`,
      job.reply_to_wamid
    );
    await reportCallback(job, {
      status: 'failed',
      error_message: errMsg.slice(0, 400),
    });
    process.exitCode = 1;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main();
