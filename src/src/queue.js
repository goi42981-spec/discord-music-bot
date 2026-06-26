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
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

let _yt = null;

// Парсер Netscape Cookie File в стандартную строку HTTP Cookie Header
function parseNetscapeCookies(cookieText) {
  if (!cookieText) return '';
  return cookieText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const parts = line.split('\t');
      if (parts.length >= 7) {
        const name = parts[5];
        const value = parts[6];
        return `${name}=${value}`;
      }
      return null;
    })
    .filter(Boolean)
    .join('; ');
}

// Инициализация Innertube с поддержкой куки (преобразованных в валидный заголовок)
async function getYt() {
  if (!_yt) {
    const config = { retrieve_player: true };
    if (process.env.YT_COOKIES) {
      config.cookie = parseNetscapeCookies(process.env.YT_COOKIES);
    }
    _yt = await Innertube.create(config);
  }
  return _yt;
}

// Запись куки во временный файл для yt-dlp (ему нужен именно сырой Netscape-формат)
let cookiesPath = null;
if (process.env.YT_COOKIES) {
  try {
    const tempDir = '/tmp';
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }
    cookiesPath = join(tempDir, 'yt-cookies.txt');
    writeFileSync(cookiesPath, process.env.YT_COOKIES);
    console.log('✅ YouTube cookies успешно загружены в среду окружения и сохранены в файл.');
  } catch (err) {
    console.error('❌ Ошибка при сохранении куки-файла:', err.message);
  }
} else {
  console.warn('⚠️ Внимание: Переменная окружения YT_COOKIES не задана. Возможны ошибки авторизации!');
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
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      return reject(new Error('Передан неверный или пустой URL для yt-dlp'));
    }

    // Динамическая адаптация параметров под наличие куки:
    // 1. Если куки загружены (они экспортированы из десктопного браузера) -> используем web-клиент и десктопный UA.
    // 2. Если куки нет -> маскируемся под мобильный клиент (ios, android), которые реже требуют капчу.
    const clientType = cookiesPath 
      ? 'youtube:player_client=web,tv' 
      : 'youtube:player_client=ios,android,tv';

    const userAgent = cookiesPath
      ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

    const args = [
      '--extractor-args', `${clientType};player_skip_fallback=info`,
      '--user-agent', userAgent,
      '--no-playlist',
      '-f', 'bestaudio/best',
      '--get-url',
      '--quiet',
      '--no-warnings',
    ];
    
    if (cookiesPath) {
      args.push('--cookies', cookiesPath);
    }
    
    // Ссылка идет последней
    args.push(url);
    
    const proc = spawn('yt-dlp', args);
    let data = '';
    let errData = '';
    
    proc.stdout.on('data', (d) => { data += d; });
    proc.stderr.on('data', (d) => { errData += d; });
    
    proc.on('close', (code) => {
      const directUrl = data.trim().split('\n')[0];
      if (code !== 0 || !directUrl) {
        reject(new Error(errData.trim() || `yt-dlp завершился с кодом ${code}`));
      } else {
        resolve(directUrl);
      }
    });
    proc.on('error', reject);
  });
}

async function createStream(url) {
  const directUrl = await getDirectUrl(url);
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
  queue.textChannel?.send(`▶️ **Сейчас играет:** ${track.title}`).catch(() => {});
  try {
    const stream = await createStream(track.url);
    const resource = createAudioResource(stream, { inputType: StreamType.Raw });
    queue.player.play(resource);
  } catch (err) {
    console.error('Ошибка воспроизведения трека:', err.message);
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
  queue.player?.stop(true);
  return true;
}
