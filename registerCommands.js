const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join voice channel'),
  async execute(interaction) {
    if (interaction.member.voice.channel) {
      const connection = joinVoiceChannel({
        channelId: interaction.member.voice.channel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      logToConsole('> Joined voice channel', 'info', 1);
      handleRecording(connection, interaction.member.voice.channel);

      await interaction.reply({ content: 'Joined voice channel.', ephemeral: true });
    } else {
      await interaction.reply({ content: 'You need to join a voice channel first!', ephemeral: true });
    }
  },
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave voice channel'),
  async execute(interaction) {
    if (connection) {
      leaveVoiceChannel(connection);
      logToConsole('> Left voice channel', 'info', 1);
      await interaction.reply({ content: 'Left voice channel.', ephemeral: true });
    } else {
      await interaction.reply({ content: 'I am not in a voice channel!', ephemeral: true });
    }
  },
};
