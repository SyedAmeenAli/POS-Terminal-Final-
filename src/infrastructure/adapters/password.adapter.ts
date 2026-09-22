import { argon2id, hash, verify, type HashOptions } from "argon2";

const passwordHashOptions: HashOptions & { raw?: false } = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export const hashPassword = async (plain: string): Promise<string> =>
  hash(plain, passwordHashOptions) as Promise<string>;

export const verifyPassword = async (plain: string, hash: string): Promise<boolean> => {
  try {
    return await verify(hash, plain);
  } catch {
    return false;
  }
};
