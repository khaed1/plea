// Telegram alerts with de-duplication. Without a bot token and chat id, alerts go to the log only.

export function makeAlerter(cfg, log) {
  async function send(text) {
    log({ level: 'alert', text });
    if (!cfg.telegramToken || !cfg.telegramChat) return;
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.telegramChat, text: `PLEA keeper: ${text}`, disable_web_page_preview: true }),
      });
      if (!res.ok) log({ level: 'warn', msg: 'telegram refused', status: res.status });
    } catch (e) {
      log({ level: 'warn', msg: 'telegram unreachable', error: String(e?.message ?? e) });
    }
  }

  /** Sends each alert unless the same key was sent within ALERT_REPEAT_HOURS (or ever, for `once`). */
  async function raise(state, alerts, nowSeconds) {
    const repeat = cfg.alertRepeatHours * 3600;
    for (const a of alerts) {
      const last = state.alerts[a.key];
      if (last !== undefined && (a.once || nowSeconds - last < repeat)) continue;
      state.alerts[a.key] = nowSeconds;
      await send(a.text);
    }
  }

  return { send, raise };
}
