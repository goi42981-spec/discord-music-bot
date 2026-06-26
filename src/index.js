import { createServer } from 'http';
import sodium from 'libsodium-wrappers';
import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { handlePlay } from './src/commands/play.js';
import { handleSkip } from './src/commands/skip.js';
import { handleCancel } from './src/commands/cancel.js';

await sodium.ready;

const PORT = process.env.PORT || 3001;
createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
}).listen(PORT, () => {
  console.log(`Health-check сервер запущен на порту ${PORT}`);
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN не задан!');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Воспроизвести видео или плейлист YouTube')
    .addStringOption(opt =>
      opt.setName('url')
        .setDescription('Ссылка на YouTube видео или плейлист')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Пропустить текущий трек'),
  new SlashCommandBuilder()
    .setName('cancel')
    .setDescription('Отменить всю очередь и остановить воспроизведение'),
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Бот запущен: ${c.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(c.user.id), { body: commands.map(cmd => cmd.toJSON()) });
    console.log('✅ Slash commands зарегистрированы.');
  } catch (err) {
    console.error('Ошибка регистрации команд:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  try {
    if (commandName === 'play') await handlePlay(interaction);
    else if (commandName === 'skip') await handleSkip(interaction);
    else if (commandName === 'cancel') await handleCancel(interaction);
  } catch (err) {
    console.error('Ошибка команды:', err);
    const msg = '❌ Произошла ошибка при выполнении команды.';
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

client.login(token);
