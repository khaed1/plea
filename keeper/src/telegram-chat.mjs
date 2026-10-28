// Lists the chats that have written to the bot, to find TELEGRAM_CHAT_ID. Send your bot any
// message first (or add it to a group and write there), then:
//   node --env-file=.env src/telegram-chat.mjs

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN in .env first (from @BotFather).');
  process.exit(1);
}
const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const body = await res.json();
if (!body.ok) {
  console.error(`Telegram refused: ${body.description ?? res.status}`);
  process.exit(1);
}
const chats = new Map();
for (const u of body.result ?? []) {
  const c = (u.message ?? u.channel_post ?? u.my_chat_member ?? u.edited_message)?.chat;
  if (c) chats.set(c.id, c.title ?? c.username ?? c.first_name ?? c.type);
}
if (chats.size === 0) console.log('No messages yet: send your bot a message, then run this again.');
for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}   (${name})`);
