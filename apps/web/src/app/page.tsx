import { SystemStatus } from '@/components/system-status';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-8 px-6">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">Forge</h1>
        <p className="mt-3 text-muted-foreground">
          AI-assisted engineering issue and project management
        </p>
      </div>
      <SystemStatus />
    </main>
  );
}
