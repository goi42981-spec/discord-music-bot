import { skipCurrent } from '../queue.js';

export async function handleSkip(interaction) {
  const guildId = interaction.guild.id;
  const skipped = skipCurrent(guildId);
  if (skipped) {
    await interaction.reply({ content: '⏭️ Трек пропущен!' });
  } else {
    await interaction.reply({ content: '❌ Сейчас ничего не играет.', ephemeral: true });
  }
}
