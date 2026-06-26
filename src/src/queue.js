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
import { writeFileSync, existsSync } from 'fs';

const COOKIES_PATH = '/tmp/yt-cookies.txt';
if (process.env.YOUTUBE_COOKIES) {
  writeFileSync(COOKIES_PATH, process.env.YOUTUBE_COOKIES);
}

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

function getDirectUrl(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--extractor-args', 'youtube:player_client=android',
      '--no-playlist',
      '-f', 'bestaudio/best',
      '--get-url',
      '--quiet',
    ];
    if (existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
    args.push(url);

    const proc = spawn('yt-dlp', args);
    let data = '';
    let errData = '';
    proc.stdout.on('data', (d) => { data += d; });
    proc.stderr.on('data', (d) => { errData += d; });
    proc.on('close', (code) => {
      const directUrl = data.trim().split('\n')[0];
      if (directUrl) resolve(directUrl);
      else reject(new Error(errData.trim() || 'yt-dlp failed'));
    });
    proc.on('error', reject);
  });
}

async function createYtdlpStream(url) {
  const directUrl = await getDirectUrl(url);
  console.log('[stream] URL получен, запускаю ffmpeg...');
  const ffmpeg = spawn('ffmpeg', [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', directUrl, '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', '-loglevel', 'error', 'pipe:1',
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
    const stream = await createYtdlpStream(track.url);
    const resource = createAudioResource(stream, { inputType: StreamType.Raw });
    queue.player.play(resource);
  } catch (err) {
    console.error('Ошибка стрима:', err.message);
    queue.textChannel?.send(`❌ Не удалось воспроизвести: **${track.title}**. Пропускаю...`).catch(() => {});
    playNext(guildId);
  }
}

export async function addToQueue(interaction, voiceChannel, tracks) {
  const guildId = interaction.guild.id;
  const queue = getQueue(guildId);
  queue.textChannel = interaction.channel;
  if (!queue.connection) {
    queue.connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId, adapterCreator: interaction.guild.voiceAdapterCreator });
    queue.connection.on('error', (err) => console.error('[voice error]', err.message));
    try {
      await entersState(queue.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      queue.connection.destroy();
      queues.delete(guildId);
      throw new Error('Не удалось подключиться к голосовому каналу.');
    }
    queue.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(queue.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(queue.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch { deleteQueue(guildId); }
    });
    queue.player = createAudioPlayer();
    queue.connection.subscribe(queue.player);
    queue.player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
    queue.player.on('error', (err) => { console.error('Ошибка плеера:', err.message); playNext(guildId); });
  }
  for (const track of tracks) queue.tracks.push(track);
  if (!queue.playing) playNext(guildId);
}

export function skipCurrent(guildId) {
  const queue = queues.get(guildId);
  if (!queue || !queue.player) return false;
  queue.player.stop();
  return true;
}

export function cancelQueue(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return false;
  queue.tracks = [];
  try { queue.player?.stop(true); } catch {}
  queue.playing = false;
  setTimeout(() => deleteQueue(guildId), 1000);
  return true;
}
