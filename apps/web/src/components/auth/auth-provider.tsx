'use client';

import {
  type LoginRequest,
  type RegisterRequest,
  SESSION_HINT_COOKIE,
  type UserProfile,
} from '@forge/types';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { refreshSession, setSessionExpiredHandler } from '@/lib/api';
import { authApi } from '@/lib/auth-api';

type AuthState =
  | { status: 'loading'; user: null }
  | { status: 'authenticated'; user: UserProfile }
  | { status: 'anonymous'; user: null };

interface AuthContextValue {
  state: AuthState;
  login: (body: LoginRequest) => Promise<void>;
  register: (body: RegisterRequest) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function hasSessionHint(): boolean {
  return document.cookie.split('; ').some((c) => c.startsWith(`${SESSION_HINT_COOKIE}=`));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null });

  // On load, turn the refresh cookie (if any) into an in-memory access token.
  useEffect(() => {
    let cancelled = false;
    const restore = hasSessionHint() ? refreshSession() : Promise.resolve(null);
    void restore.then((session) => {
      if (cancelled) return;
      setState(
        session
          ? { status: 'authenticated', user: session.user }
          : { status: 'anonymous', user: null },
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      queryClient.clear();
      setState({ status: 'anonymous', user: null });
      router.replace('/login?expired=1');
    });
    return () => {
      setSessionExpiredHandler(undefined);
    };
  }, [router, queryClient]);

  const login = useCallback(async (body: LoginRequest) => {
    const session = await authApi.login(body);
    setState({ status: 'authenticated', user: session.user });
  }, []);

  const register = useCallback(async (body: RegisterRequest) => {
    const session = await authApi.register(body);
    setState({ status: 'authenticated', user: session.user });
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => undefined);
    // Drop everything fetched for this person, so whoever signs in next in this tab never sees
    // it, not even for the moment before their own data arrives (ASVS 8.2.3).
    queryClient.clear();
    setState({ status: 'anonymous', user: null });
    router.replace('/login');
  }, [router, queryClient]);

  const value = useMemo(
    () => ({ state, login, register, logout }),
    [state, login, register, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
