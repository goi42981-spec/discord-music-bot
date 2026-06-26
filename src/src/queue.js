import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} from '@discordjs/voice';
import { Innertube } from 'youtubei.js';
import { spawn } from 'child_process';

let _yt = null;
async function getYt() {
  if (!_yt) _yt = await Innertube.create({ retrieve_player: true });
  return _yt;
}

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2];
    return u.searchParams.get('v');
  } catch { return null; }
}

function extractPlaylistId(url) {
  try { return new URL(url).searchParams.get('list'); } catch { return null; }
}

export async function getVideoInfo(url) {
  const yt = await getYt();
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Не удалось извлечь ID видео из ссылки.');
  const info = await yt.getInfo(videoId);
  return { title: info.basic_info.title ?? videoId, webpage_url: `https://www.youtube.com/watch?v=${videoId}` };
}

export async function getPlaylistInfo(url) {
  const yt = await getYt();
  const listId = extractPlaylistId(url);
  if (!listId) throw new Error('Не удалось извлечь ID плейлиста.');
  const playlist = await yt.getPlaylist(listId);
  const rawVideos = Array.from(playlist.videos);
  const entries = rawVideos
    .filter(v => v.content_id && v.content_type === 'VIDEO')
    .map(v => {
      const id = v.content_id;
      const title = v.metadata?.title?.text ?? v.metadata?.title ?? id;
      return { id, title, url: `https://www.youtube.com/watch?v=${id}` };
    });
  if (entries.length === 0) throw new Error('Плейлист пустой или недоступен');
  const playlistTitle = playlist.info?.title?.text ?? playlist.info?.title ?? 'Плейлист';
  return { title: playlistTitle, entries };
}

async function getStreamUrl(url) {
  const yt = await getYt();
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Не удалось извлечь ID видео.');
  const info = await yt.getInfo(videoId);
  const formats = info.streaming_data?.adaptive_formats ?? [];
  const audioFormats = formats.filter(f => f.mime_type?.startsWith('audio/'));
  if (audioFormats.length === 0) throw new Error('Нет аудио форматов.');
  audioFormats.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  const best = audioFormats[0];
  const streamUrl = best.url;
  if (!streamUrl) throw new Error('URL аудио не найден.');
  console.log('[stream] youtubei URL получен');
  return streamUrl;
}

async function createStream(url) {
  const audioUrl = await getStreamUrl(url);
  const ffmpeg = spawn('ffmpeg', [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', audioUrl,
    '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', '-loglevel', 'error', 'pipe:1',
  ]);
  ffmpeg.stderr.on('data', (d) => { const msg = d.toString().trim(); if (msg) console.error('[ffmpeg]', msg); });
  ffmpeg.on('error', (err) => console.error('[ffmpeg spawn]', err.message));
  return ffmpeg.stdout;
}

const queues = new Map();

function getQueue(guildId) {
  if (!queues.has(guildId)) queues.set(guildId, { tracks: [], connection: null, player: null, textChannel: null, playing: false });
  return queues.get(guildId);
}

function deleteQueue(guildId) {
  const queue = queues.get(guildId);
  if (queue) {
    try { queue.player?.stop(true); } catch {}
    try { queue.connection?.destroy(); } catch {}
    queues.delete(guildId);
  }
}

async function playNext(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;
  if (queue.tracks.length === 0) {
    queue.playing = false;
    queue.textChannel?.send('✅ Очередь закончилась. Пока!').catch(() => {});
    setTimeout(() => { const q = queues.get(guildId); if (q && !q.playing && q.tracks.length === 0) deleteQueue(guildId); }, 60000);
    return;
  }
  const track = queue.tracks.shift();
  queue.playing = true;
  console.log(`▶️ [${guildId}] Играет: ${track.title}`);
  queue.textChannel?.send(`▶️ **Сейчас играет:** ${track.title}`).catch(() => {});
  try {
    const stream = await createStream(track.url);
    const resource = createAudioResource(stream, { inputType: StreamType.Raw });
    queue.player.play(resource);
  } catch (err) {
    console.error
