import User from "../../models/User";
import AppError from "../../errors/AppError";
import {
  createAccessToken,
  createRefreshToken
} from "../../helpers/CreateTokens";
import Queue from "../../models/Queue";

interface Request {
  email: string;
  password: string;
}

interface Response {
  user: User;
  token: string;
  refreshToken: string;
  usuariosOnline?: User[];
}

const AuthUserService = async ({
  email,
  password
}: Request): Promise<Response> => {
  const user = await User.findOne({
    where: { email },
    include: [{ model: Queue, as: "queues" }]
  });
  // attributes: [
  //   "id",
  //   "email",
  //   "name",
  //   "lastLogin",
  //   "profile",
  //   "tenantId",
  //   "configs",
  //   "isOnline"
  // ]

  const token = createAccessToken(user);
  const refreshToken = createRefreshToken(user);
  await user.update({
    isOnline: true,
    status: "online",
    lastLogin: new Date()
  });

  // retornar listagem de usuarios online
  const usuariosOnline = await User.findAll({
    where: { tenantId: user.tenantId, isOnline: true },
    attributes: ["id", "email", "status", "lastOnline", "name", "lastLogin"]
    // include: [{ model: Queue, as: "queues" }]
  });

  return {
    user,
    token,
    refreshToken,
    usuariosOnline
  };
};

export default AuthUserService;
