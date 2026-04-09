export default function Loading() {
  return (
    <div className="w-full flex-1 p-8 space-y-6 animate-pulse">
      <div className="h-10 w-64 bg-zinc-200 rounded-md dark:bg-zinc-800"></div>
      <div className="h-6 w-96 bg-zinc-100 rounded-md dark:bg-zinc-900"></div>
      
      <div className="grid md:grid-cols-3 gap-6 mt-8">
        <div className="md:col-span-1 h-64 bg-zinc-100 rounded-xl border border-zinc-200 dark:bg-zinc-900 dark:border-zinc-800"></div>
        <div className="md:col-span-2 h-64 bg-zinc-100 rounded-xl border border-zinc-200 dark:bg-zinc-900 dark:border-zinc-800"></div>
      </div>
      
      <div className="h-96 w-full bg-zinc-100 rounded-xl border border-zinc-200 mt-6 dark:bg-zinc-900 dark:border-zinc-800"></div>
    </div>
  )
}
