import { getMe } from "@workspace/api-client-react";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

// The built-in login (email/password, OAuth, stored bearer token) was
// removed. The signed-in user is whatever GET /auth/me resolves to on the
// server (see api-server middleware/auth.ts resolveIdentity). When the new
// login system lands, this is the place to attach its credentials — e.g.
// register a token getter with `setAuthTokenGetter` from
// @workspace/api-client-react.

export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
  role: string;
  selectedMode: "beginner" | "pro";
  themePreference: string;
  onboardingCompleted: boolean;
  avatarUrl: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  refresh: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await getMe();
      setUser(me as AuthUser);
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ user, isLoading, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
