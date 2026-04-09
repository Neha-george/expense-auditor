'use client'

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center bg-zinc-50 dark:bg-zinc-950 p-6">
      <div className="max-w-md w-full space-y-6 text-center border p-8 rounded-xl bg-white shadow-sm dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800">
        <h2 className="text-2xl font-bold text-red-600">Something went wrong</h2>
        <p className="text-sm text-zinc-500 bg-zinc-100 p-3 rounded text-left font-mono overflow-auto dark:bg-zinc-800 dark:text-zinc-400">
          {error.message}
        </p>
        <button
          onClick={() => reset()}
          className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-900 px-8 text-sm font-medium text-zinc-50 shadow transition-colors hover:bg-zinc-900/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-950 disabled:pointer-events-none disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-50/90"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
