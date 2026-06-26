import { cancelQueue } from '../queue.js';

export async function handleCancel(interaction) {
  const cancelled = cancelQueue(interaction.guild.id);
  if (cancelled) await interaction.reply('🛑 Очередь отменена. Воспроизведение остановлено.');
  else await interaction.reply({ content: '❌ Нет активной очереди.', ephemeral: true });
}
