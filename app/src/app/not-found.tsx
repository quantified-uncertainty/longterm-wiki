export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
      <h1 className="text-2xl font-bold">Page Not Found</h1>
      <p className="text-muted-foreground">The page you are looking for does not exist.</p>
      <a href="/" className="text-primary hover:underline">Go back home</a>
    </div>
  );
}
