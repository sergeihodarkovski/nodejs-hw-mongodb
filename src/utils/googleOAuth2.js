import { OAuth2Client } from 'google-auth-library';
import path from 'node:path';
import { readFile } from 'fs/promises';

import { getEnvVar } from './getEnvVar.js';
import createHttpError from 'http-errors';

const PATH_JSON = path.join(process.cwd(), 'google-oauth.json');

let oauthConfig;
try {
  const fileData = await readFile(PATH_JSON, 'utf-8');
  oauthConfig = JSON.parse(fileData);
} catch (error) {
  console.error('Error reading google-oauth.json:', error);
  throw new Error('Failed to load OAuth configuration.');
}

const googleOAuthClient = new OAuth2Client({
  clientId: getEnvVar('GOOGLE_AUTH_CLIENT_ID'),
  clientSecret: getEnvVar('GOOGLE_AUTH_CLIENT_SECRET'),
  redirectUri: oauthConfig.web.redirect_uris[0],
});

export const generateAuthUrl = () =>
  googleOAuthClient.generateAuthUrl({
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  });

export const validateCode = async (code) => {
  try {
    const response = await googleOAuthClient.getToken({
      code,
      redirect_uri: oauthConfig.web.redirect_uris[0],
    });

    if (!response.tokens.id_token) throw createHttpError(401, 'Unauthorized');

    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: response.tokens.id_token,
      audience: getEnvVar('GOOGLE_AUTH_CLIENT_ID'),
    });

    return ticket;
  } catch (error) {
    console.error('Google OAuth validation error:', error);
    throw createHttpError(401, 'Failed to verify Google token.');
  }
};

export const getFullNameFromGoogleTokenPayload = (payload) => {
  let fullName = 'Guest';
  if (payload.given_name && payload.family_name) {
    fullName = `${payload.given_name} ${payload.family_name}`;
  } else if (payload.given_name) {
    fullName = payload.given_name;
  }
  return fullName;
};
