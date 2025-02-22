import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import mongoose from 'mongoose';
import { UsersCollection } from '../db/models/user.js';
import createHttpError from 'http-errors';
import { SessionsCollection } from '../db/models/session.js';
import { FIFTEEN_MINUTES, ONE_DAY } from '../constants/index.js';
import { env } from '../utils/env.js';
import { sendEmail } from '../utils/sendMail.js';
import {
  getFullNameFromGoogleTokenPayload,
  validateCode,
} from '../utils/googleOAuth2.js';

export const registerUser = async (payload) => {
  const user = await UsersCollection.findOne({ email: payload.email });
  if (user) throw createHttpError(409, 'Email in use');

  const encryptedPassword = await bcrypt.hash(payload.password, 10);

  return await UsersCollection.create({
    ...payload,
    password: encryptedPassword,
  });
};

export const loginUser = async (payload) => {
  const user = await UsersCollection.findOne({ email: payload.email });
  if (!user) {
    throw createHttpError(404, 'User not found');
  }
  const isEqual = await bcrypt.compare(payload.password, user.password);

  if (!isEqual) {
    throw createHttpError(401, 'Unauthorized');
  }

  await SessionsCollection.deleteMany({ userId: user._id });

  const accessToken = randomBytes(30).toString('hex');
  const refreshToken = randomBytes(30).toString('hex');

  return await SessionsCollection.create({
    userId: user._id,
    accessToken,
    refreshToken,
    accessTokenValidUntil: new Date(Date.now() + FIFTEEN_MINUTES),
    refreshTokenValidUntil: new Date(Date.now() + ONE_DAY),
  });
};

export const logoutUser = async (sessionId) => {
  if (!sessionId) {
    throw createHttpError(400, 'Session ID is required');
  }

  const result = await SessionsCollection.deleteOne({
    _id:
      sessionId instanceof mongoose.Types.ObjectId
        ? sessionId
        : new mongoose.Types.ObjectId(sessionId),
  });

  if (result.deletedCount === 0) {
    throw createHttpError(404, 'Session not found');
  }
};

const createSession = () => {
  const accessToken = randomBytes(30).toString('hex');
  const refreshToken = randomBytes(30).toString('hex');

  return {
    accessToken,
    refreshToken,
    accessTokenValidUntil: new Date(Date.now() + FIFTEEN_MINUTES),
    refreshTokenValidUntil: new Date(Date.now() + ONE_DAY),
  };
};

export const refreshUsersSession = async ({ sessionId, refreshToken }) => {
  const session = await SessionsCollection.findOne({
    _id:
      sessionId instanceof mongoose.Types.ObjectId
        ? sessionId
        : new mongoose.Types.ObjectId(sessionId),
    refreshToken,
  });

  if (!session) {
    throw createHttpError(401, 'Session not found');
  }

  const isSessionTokenExpired =
    new Date() > new Date(session.refreshTokenValidUntil);

  if (isSessionTokenExpired) {
    throw createHttpError(401, 'Session token expired');
  }

  const newSession = createSession();
  const createdSession = await SessionsCollection.create({
    userId: session.userId,
    ...newSession,
  });

  await SessionsCollection.deleteOne({
    _id:
      sessionId instanceof mongoose.Types.ObjectId
        ? sessionId
        : new mongoose.Types.ObjectId(sessionId),
  });

  return createdSession;
};

export const requestResetToken = async (email) => {
  const user = await UsersCollection.findOne({ email });
  if (!user) {
    throw createHttpError(404, 'User not found');
  }

  const resetToken = jwt.sign(
    {
      sub: user._id,
      email,
    },
    env('JWT_SECRET'),
    {
      expiresIn: '5m',
    },
  );

  const resetUrl = `${env('APP_DOMAIN')}/reset-password?token=${resetToken}`;

  try {
    await sendEmail({
      from: env('SMTP_FROM'),
      to: email,
      subject: 'Reset your password',
      html: `<p>Click <a href="${resetUrl}">here</a> to reset your password!</p>`,
    });
  } catch {
    throw createHttpError(
      500,
      'Failed to send the email, please try again later.',
    );
  }
};

export const resetPassword = async (payload) => {
  let decoded;

  try {
    decoded = jwt.verify(payload.token, env('JWT_SECRET'));
  } catch {
    throw createHttpError(401, 'Token is expired or invalid.');
  }

  const user = await UsersCollection.findOne({
    email: decoded.email,
    _id: decoded.sub,
  });

  if (!user) {
    throw createHttpError(404, 'User not found');
  }

  if (!payload.password) {
    throw createHttpError(400, 'New password is required.');
  }

  const encryptedPassword = await bcrypt.hash(payload.password, 10);

  await UsersCollection.updateOne(
    { _id: user._id },
    { password: encryptedPassword },
  );
};

export const loginOrSignupWithGoogle = async (code) => {
  const loginTicket = await validateCode(code);
  const payload = loginTicket.getPayload();
  if (!payload) throw createHttpError(401);

  let user = await UsersCollection.findOne({ email: payload.email });
  if (!user) {
    const password = await bcrypt.hash(randomBytes(10), 10);
    user = await UsersCollection.create({
      email: payload.email,
      name: getFullNameFromGoogleTokenPayload(payload),
      password,
      role: 'parent',
    });
  }

  const newSession = createSession();

  return await SessionsCollection.create({
    userId: user._id,
    ...newSession,
  });
};
