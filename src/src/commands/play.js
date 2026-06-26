import { addToQueue, getVideoInfo, getPlaylistInfo } from '../queue.js';

const YOUTUBE_URL_RE = /(?:youtube\.com\/(?:watch\?|shorts\/|playlist)|youtu\.be\/)/;
const YOUTUBE_PLAYLIST_ONLY_RE = /youtube\.com\/playlist/;

export async function handlePlay(interaction) {
  if (Date.now() - interaction.createdTimestamp > 2500) return;

  const url = interaction.options.getString('url');
  if (!YOUTUBE_URL_RE.test(url)) {
    return interaction.reply({ content: '❌ Пожалуйста, отправь ссылку на YouTube.', flags: 64 });
  }
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: '❌ Ты должен находиться в голосовом канале!', flags: 64 });
  }

  try {
    await interaction.deferReply();
  } catch {
    return;
  }

  try {
    const isPlaylistOnly = YOUTUBE_PLAYLIST_ONLY_RE.test(url);
    const hasListParam = /[?&]list=/.test(url);
    const hasVideoId = /[?&]v=/.test(url);
    const isPlaylist = isPlaylistOnly || (hasListParam && !hasVideoId);
    let tracks = [];
    if (isPlaylist) {
      const info = await getPlaylistInfo(url);
      if (info.entries && info.entries.length > 0) {
        for (const entry of info.entries) {
          if (!entry.id) continue;
          tracks.push({ title: entry.title || entry.id, url: entry.url || `https://www.youtube.com/watch?v=${entry.id}` });
        }
        await interaction.editReply(`✅ Добавлено **${tracks.length}** треков из плейлиста **${info.title}** в очередь.`);
      } else {
        return interaction.editReply('❌ Не удалось найти треки в плейлисте.');
      }
    } else {
      const info = await getVideoInfo(url);
      tracks.push({ title: info.title || 'Неизвестный трек', url: info.webpage_url || url });
      await interaction.editReply(`✅ Добавлено в очередь: **${info.title}**`);
    }
    if (tracks.length === 0) return interaction.editReply('❌ Не удалось получить треки.');
    await addToQueue(interaction, voiceChannel, tracks);
  } catch (err) {
    console.error('Ошибка play:', err);
    await interaction.editReply(`❌ Ошибка: ${err.message}`).catch(() => {});
  }
}
