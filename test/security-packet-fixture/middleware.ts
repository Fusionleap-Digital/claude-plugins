export { auth as middleware } from './auth';

// Only the dashboard and the chat API are behind sign-in here.
export const config = {
  matcher: ['/dashboard/:path*', '/api/chat/:path*'],
};
