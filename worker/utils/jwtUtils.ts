import { jwtVerify, SignJWT } from 'jose';
import { TokenPayload } from '../types/auth-types';
import { SecurityError, SecurityErrorType } from 'shared/types/errors';
import { jwtSecretProblems } from 'shared/utils/jwt-secret';
import { createLogger } from '../logger';
import { SessionService } from 'worker/database/services/SessionService';

const logger = createLogger('JWTUtils');

export class JWTUtils {
    private static instance: JWTUtils | null = null;
    private jwtSecret: Uint8Array;
    private readonly algorithm = 'HS256';

    private constructor(jwtSecret: string) {
        this.validateJWTSecret(jwtSecret);
        this.jwtSecret = new TextEncoder().encode(jwtSecret);
    }

    static getInstance(env: { JWT_SECRET: string }): JWTUtils {
        if (!env.JWT_SECRET) {
            throw new Error('JWT_SECRET not configured');
        }
        
        if (!JWTUtils.instance) {
            JWTUtils.instance = new JWTUtils(env.JWT_SECRET);
        }
        return JWTUtils.instance;
    }

    private validateJWTSecret(secret: string): void {
        const [problem] = jwtSecretProblems(secret);
        if (problem) {
            throw new Error(problem);
        }
    }

    async signPayload(payload: Record<string, unknown>, expiresIn: number): Promise<string> {
        const now = Math.floor(Date.now() / 1000);
        return new SignJWT({ ...payload })
            .setProtectedHeader({ alg: this.algorithm })
            .setIssuedAt(now)
            .setExpirationTime(now + expiresIn)
            .sign(this.jwtSecret);
    }

    async verifyPayload(token: string): Promise<Record<string, unknown> | null> {
        try {
            const { payload } = await jwtVerify(token, this.jwtSecret, { algorithms: [this.algorithm] });
            return payload as Record<string, unknown>;
        } catch {
            return null;
        }
    }

    async createToken(payload: Omit<TokenPayload, 'iat' | 'exp'>, expiresIn: number = 24 * 3600): Promise<string> {
        try {
            return await this.signPayload(payload as Record<string, unknown>, expiresIn);
        } catch (error) {
            logger.error('Error creating token', error);
            throw new SecurityError(
                SecurityErrorType.INVALID_TOKEN,
                'Failed to create token',
                500
            );
        }
    }

    async verifyToken(token: string): Promise<TokenPayload | null> {
        const payload = await this.verifyPayload(token);
        if (!payload) return null;

        if (!payload.sub || !payload.email || !payload.type || !payload.exp || !payload.iat) {
            return null;
        }

        return {
            sub: payload.sub as string,
            email: payload.email as string,
            type: payload.type as 'access' | 'refresh',
            exp: payload.exp as number,
            iat: payload.iat as number,
            jti: payload.jti as string | undefined,
            sessionId: payload.sessionId as string
        };
    }

    // -- Convenience methods --

    async createAccessToken(userId: string, email: string, sessionId: string): Promise<{
        accessToken: string;
        expiresIn: number;
    }> {
        const accessTokenExpiry = SessionService.config.sessionTTL;

        const payload = { sub: userId, email, sessionId };

        const accessToken = await this.createToken({
                ...payload,
                type: 'access' as const,
            }, accessTokenExpiry);

        return { accessToken, expiresIn: accessTokenExpiry };
    }

    async hashToken(token: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(token);
        const hash = await crypto.subtle.digest('SHA-256', data);
        return btoa(String.fromCharCode(...new Uint8Array(hash)));
    }
}
