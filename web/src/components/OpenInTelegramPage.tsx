export function OpenInTelegramPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-12">
      <div className="space-y-2">
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
          Speculator
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Open from Telegram
        </h1>
        <p className="text-base leading-relaxed text-muted-foreground">
          This Mini App only works inside Telegram. Open it from your bot menu or Web App button so
          Telegram can sign you in.
        </p>
      </div>
    </main>
  );
}
