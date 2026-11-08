import NextAuth from 'next-auth';
import Okta from 'next-auth/providers/okta';

// Adjusters sign in with the company Okta tenant. Sessions are JWTs.
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Okta({
      clientId: process.env.AUTH_OKTA_ID,
      clientSecret: process.env.AUTH_OKTA_SECRET,
      issuer: process.env.AUTH_OKTA_ISSUER,
    }),
  ],
  session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },
  callbacks: {
    jwt({ token, profile }) {
      if (profile) token.tenantId = (profile as { tenant_id?: string }).tenant_id;
      return token;
    },
    session({ session, token }) {
      return { ...session, tenantId: token.tenantId as string };
    },
  },
});
