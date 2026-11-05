require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const http = require('http'); // HTTPサーバー用

// --- Renderのスリープ対策（簡易Webサーバー） ---
const PORT = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Discord Bot is running!');
});

server.listen(PORT, () => {
  console.log(`[DEBUG] Webサーバーがポート ${PORT} で起動しました。`);
});
// ---------------------------------------------

const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ] 
});

// ユーザーごとに「リマインド日時と対象者」を一時保存するマップ
const waitingForReUsers = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('remind')
    .setDescription('指定した日時にメッセージをリマインドするよ')
    .addMentionableOption(option =>
      option.setName('対象')
        .setDescription('通知時にメンションする人、ロール、または @everyone')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('time')
        .setDescription('一括入力する場合 (例: 2026.11.4.10.40.am または 2026.11.4.12.00)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('年')
        .setDescription('年 (例: 2026)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('月')
        .setDescription('月 (例: 11)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('日')
        .setDescription('日 (例: 4)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('時')
        .setDescription('時 (例: 10)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('分')
        .setDescription('分 (例: 40)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('ampm')
        .setDescription('AMまたはPM (個別入力時のみ)')
        .setRequired(false)
        .addChoices(
          { name: 'AM', value: 'am' },
          { name: 'PM', value: 'pm' }
        )),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('リマインダーボットの使い方を表示するよ')
].map(command => command.toJSON());

client.once('clientReady', async () => {
  console.log(`[DEBUG] ${client.user.tag} としてログインしたよ。`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('[DEBUG] スラッシュコマンドの登録を開始するよ。');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands },
    );
    console.log('[DEBUG] スラッシュコマンドの登録が完了したよ！');
  } catch (error) {
    console.error('[DEBUG] コマンドの登録に失敗したよ:', error);
  }
});

// メッセージ監視（「re」の検知）
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  if (waitingForReUsers.has(message.author.id)) {
    const content = message.content.trim().toLowerCase();
    console.log(`[DEBUG messageCreate] 待機中のユーザー ${message.author.tag} からメッセージ受信: "${message.content}"`);

    if (content === 're') {
      const reminderData = waitingForReUsers.get(message.author.id);
      waitingForReUsers.delete(message.author.id);

      let targetMessage = null;
      if (message.reference) {
        try {
          targetMessage = await message.channel.messages.fetch(message.reference.messageId);
        } catch (e) {
          console.log(`[DEBUG] 対象メッセージの取得に失敗しました: ${e.message}`);
        }
      }

      await message.reply(`OK！ ${reminderData.targetDate.toLocaleString()} にリマインダーをセットしたよ！`);

      if (targetMessage) {
        try {
          await targetMessage.reply(`${reminderData.mentionTarget} このメッセージのリマインドを設定したよ！`);
          console.log(`[DEBUG] 対象メッセージへリプライを送信しました。`);
        } catch (err) {
          console.log(`[DEBUG] 対象メッセージへのリプライ送信に失敗しました: ${err.message}`);
        }
      }

      console.log(`[DEBUG] リマインダー登録完了。遅延時間(ミリ秒): ${reminderData.delay}`);

      setTimeout(async () => {
        try {
          console.log(`[DEBUG] リマインダーの時間になりました。通知を送信します。`);
          const options = {
            content: `${reminderData.mentionTarget} このメッセージまたは投票をチェックしよう！`
          };
          
          if (targetMessage) {
            options.reply = { messageReference: targetMessage.id };
          }

          await message.channel.send(options);
          console.log(`[DEBUG] リマインダーの通知送信が完了しました。`);
        } catch (err) {
          console.error(`[DEBUG] リマインダーの送信に失敗しました:`, err);
        }
      }, reminderData.delay);
    }
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'help') {
    return await interaction.reply({
      content: '🤖 **リマインダーボットの使い方**\n\n' +
               '1. `/remind` コマンドを実行します。\n' +
               '   - **対象**: 通知したいユーザー、ロール、または `@everyone` を選択します。\n' +
               '   - **日時**: `time` に `2026.11.4.10.40.am` のように一括入力するか、年・月・日・時・分を個別に選びます。\n' +
               '2. ボットが「どのメッセージにする？」と聞いて返信するので、**リマインドしたいメッセージや投票に対して「re」と返信（リプライ）**します。\n' +
               '3. 設定が完了すると、指定した日時に選択した対象をメンションして通知が届きます！',
      ephemeral: true
    });
  }

  if (interaction.commandName === 'remind') {
    const mentionTarget = interaction.options.getMentionable('対象');
    const timeArg = interaction.options.getString('time');
    let year, month, day, hour, minute;

    console.log(`[DEBUG] /remind コマンドが実行されました。ユーザー: ${interaction.user.tag}`);

    if (timeArg) {
      console.log(`[DEBUG] 一括入力モード: ${timeArg}`);
      const parts = timeArg.toLowerCase().split('.');

      if (parts.length < 5) {
        return await interaction.reply({ 
          content: 'エラー: 日時の形式が正しくないよ！ 例: `2026.11.4.10.40` または `2026.11.4.10.40.am`', 
          flags: [MessageFlags.Ephemeral]
        });
      }

      year = parseInt(parts[0], 10);
      month = parseInt(parts[1], 10) - 1;
      day = parseInt(parts[2], 10);
      hour = parseInt(parts[3], 10);
      minute = parseInt(parts[4], 10);

      const lastPart = parts[5];
      if (lastPart === 'pm') {
        if (hour < 12) hour += 12;
      } else if (lastPart === 'am') {
        if (hour === 12) hour = 0;
      }

    } else {
      const yearStr = interaction.options.getString('年');
      const monthStr = interaction.options.getString('月');
      const dayStr = interaction.options.getString('日');
      const hourStr = interaction.options.getString('時');
      const minuteStr = interaction.options.getString('分');
      const ampm = interaction.options.getString('ampm');

      if (!yearStr || !monthStr || !dayStr || !hourStr || !minuteStr) {
        return await interaction.reply({ 
          content: 'エラー: 「time」に一括入力するか、年・月・日・時・分をすべて入力してね！', 
          ephemeral: true 
        });
      }

      year = parseInt(yearStr, 10);
      month = parseInt(monthStr, 10) - 1;
      day = parseInt(dayStr, 10);
      hour = parseInt(hourStr, 10);
      minute = parseInt(minuteStr, 10);

      if (ampm === 'pm') {
        if (hour < 12) hour += 12;
      } else if (ampm === 'am') {
        if (hour === 12) hour = 0;
      }
    }

    if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour) || isNaN(minute)) {
      return await interaction.reply({ content: 'エラー: 日時には半角数字を使用してください！', ephemeral: true });
    }

    const targetDate = new Date(year, month, day, hour, minute, 0);
    if (isNaN(targetDate.getTime())) {
      return await interaction.reply({ content: '無効な日時だよ。', ephemeral: true });
    }

    const delay = targetDate.getTime() - Date.now();
    if (delay <= 0) {
      return await interaction.reply({ content: '過去の時間は指定できないよ！', ephemeral: true });
    }

    waitingForReUsers.set(interaction.user.id, {
      targetDate: targetDate,
      delay: delay,
      mentionTarget: mentionTarget
    });

    await interaction.reply({
      content: `${interaction.user} どのメッセージにする？ 対象のメッセージまたは投票に対して「re」と返信してね！（60秒以内）`,
      ephemeral: false 
    });

    console.log(`[DEBUG] ユーザー ${interaction.user.tag} をre待ちリストに追加しました。`);

    setTimeout(() => {
      if (waitingForResUsers.has(interaction.user.id)) {
        waitingForReUsers.delete(interaction.user.id);
        console.log(`[DEBUG] ユーザー ${interaction.user.tag} のre待ち時間がタイムアウトしました。`);
      }
    }, 60000);
  }
});

client.login(process.env.DISCORD_TOKEN);
