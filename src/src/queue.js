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
  // Обрабатываем возможные экранированные переносы строк перед парсингом
  const cleanText = cookieText.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  return cleanText
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

// Инициализация Innertube с поддержкой куки и прокси (если заданы)
async function getYt() {
  if (!_yt) {
    const config = { retrieve_player: true };
    if (process.env.YT_COOKIES) {
      config.cookie = parseNetscapeCookies(process.env.YT_COOKIES);
    }
    // Если в системе прописан прокси, передаем его в Innertube
    if (process.env.YT_PROXY) {
      config.proxy = {
        url: process.env.YT_PROXY
      };
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
    
    // ВАЖНО: заменяем текстовые "\n" на настоящие символы переноса строки.
    // Часто при копировании кук в ENV-панели они сохраняются как "line1\nline2" в виде одной строки.
    const cleanCookiesText = process.env.YT_COOKIES
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r');

    writeFileSync(cookiesPath, cleanCookiesText);
    console.log('✅ YouTube cookies успешно загружены в среду окружения, отформатированы и сохранены в файл.');
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

// Внутренний метод для запуска одиночного процесса yt-dlp с переданными аргументами
function runYtdlpSingle(url, config) {
  return new Promise((resolve, reject) => {
    const args = [
      '--extractor-args', config.client,
      '--no-playlist',
      '-f', 'bestaudio/best',
      '--get-url',
      '--quiet',
      '--no-warnings',
    ];
    
    // Динамический выбор User-Agent в зависимости от типа клиента
    const isMobile = config.client.includes('ios') || (config.client.includes('android') && !config.client.includes('embedded'));
    const userAgent = isMobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      
    args.push('--user-agent', userAgent);

    if (config.useCookies && cookiesPath) {
      args.push('--cookies', cookiesPath);
    }
    
    if (process.env.YT_PROXY) {
      args.push('--proxy', process.env.YT_PROXY);
    }
    
    args.push(url);
    
    const proc = spawn('yt-dlp', args);
    let data = '';
    let errData = '';
    
    proc.stdout.on('data', (d) => { data += d; });
    proc.stderr.on('data', (d) => { errData += d; });
    
    proc.on('close', (code) => {
      const directUrl = data.trim().split('\n')[0];
      // Ссылка должна быть непустой и начинаться с протокола http
      if (code !== 0 || !directUrl || !directUrl.startsWith('http')) {
        reject(new Error(errData.trim() || `yt-dlp не вернул валидный URL (код завершения: ${code})`));
      } else {
        resolve(directUrl);
      }
    });
    proc.on('error', reject);
  });
}

function getDirectUrl(url) {
  return new Promise(async (resolve, reject) => {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      return reject(new Error('Передан неверный или пустой URL для yt-dlp'));
    }

    // Список стратегий получения ссылки по приоритету
    const strategies = [];

    // Стратегия 1: Обычные веб-клиенты с использованием куки (если куки добавлены)
    if (cookiesPath) {
      strategies.push({
        client: 'youtube:player_client=web,tv,ios',
        useCookies: true,
        desc: 'Веб/ТВ-клиенты с авторизацией (куки)'
      });
    }

    // Стратегия 2: Встроенные (Embedded) клиенты (отличный обход блокировок без куки)
    strategies.push({
      client: 'youtube:player_client=android_embedded,web_embedded,mediaconnect',
      useCookies: false,
      desc: 'Встроенные embedded-клиенты (без авторизации)'
    });

    // Стратегия 3: Запасной мобильный обходной путь
    strategies.push({
      client: 'youtube:player_client=ios,android,tv',
      useCookies: !!cookiesPath,
      desc: 'Мобильный резервный клиент'
    });

    let lastError = null;

    // Пытаемся запустить стратегии поочередно
    for (const strategy of strategies) {
      try {
        console.log(`[yt-dlp] Пробуем стратегию: ${strategy.desc}`);
        const directUrl = await runYtdlpSingle(url, strategy);
        if (directUrl) {
          console.log(`[yt-dlp] Успешно получена ссылка через стратегию: ${strategy.desc}`);
          return resolve(directUrl);
        }
      } catch (err) {
        lastError = err;
        console.warn(`[yt-dlp] Ошибка стратегии "${strategy.desc}": ${err.message}`);
      }
    }

    // Если ни одна стратегия не сработала
    reject(new Error(lastError ? lastError.message : 'Все доступные стратегии обхода YouTube завершились неудачей.'));
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
