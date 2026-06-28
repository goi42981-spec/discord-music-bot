import { skipCurrent } from '../queue.js';

export async function handleSkip(interaction) {
  const skipped = skipCurrent(interaction.guild.id);
  if (skipped) await interaction.reply('⏭️ Трек пропущен.');
  else await interaction.reply({ content: '❌ Сейчас ничего не играет.', ephemeral: true });
}
