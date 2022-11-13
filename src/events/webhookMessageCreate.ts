/* eslint-disable @typescript-eslint/no-use-before-define */
import {
  DiscordAPIError, EmbedBuilder, Events, GuildMember, Message,
} from 'discord.js';
import { MongoServerError } from 'mongodb';
import { FisiClientEventObject } from '@fisitypes';
import RegisteredMember from '@services/db/models/registeredMember';
import { collections } from '@services/db/mongo';
import { sendDMToUser } from '@utils/sendDMToUser';
import { embedFieldsToJSON } from '@utils/embedFieldsToJSON';

const MessageCreateHandler: FisiClientEventObject<Events.MessageCreate> = {
  eventName: Events.MessageCreate,
  handle: async (message: Message) => {
    if (!message.webhookId) return;

    const webhookMessage = message; // rename for clarity

    if (message.content === '`DEV:#!fisibot/registrations`') {
      const { fields } = webhookMessage.embeds[0];
      const registeredUser = new RegisteredMember(embedFieldsToJSON(fields) as RegisteredMember);
      registeredUser.base = Number(registeredUser.base); // base del alumno

      let newGuildMember: GuildMember | undefined;

      // Try to find the member in the guild
      try {
        // See https://www.reddit.com/r/Discordjs/comments/slgr4v/how_do_cache_and_fetch_work_and_what_is_the/
        newGuildMember = (
          await webhookMessage.guild?.members?.fetch(registeredUser.discordId) as GuildMember
        );
      }
      catch (error) {
        let errorMessageToMods: string;
        // let errorDMToUser: string; (can't dm user because id was not found)

        if (error instanceof DiscordAPIError) {
          errorMessageToMods = `Can't fetch user: ${error}`;
          // No DM to user (user is not in the guild or doesn't exist)
        }
        else {
          errorMessageToMods = `Unknown error when registering: ${error}`
            + `. Could not send DM to \`${registeredUser.discordId}\``;
          console.error('Unknown error when registering:', error);
        }
        // Send error feedback to the channel
        webhookMessage.react('❌');
        webhookMessage.reply(errorMessageToMods);
        return;
      }

      // Discord id was fetched

      // BEFORE VERIFYING
      // search if the user is already registered
      // https://mongoplayground.net/p/ireG-B9QiJ0
      const similarUsers = await collections.registrations?.find<RegisteredMember>({
        $or: [
          { discordId: registeredUser.discordId },
          { studentCode: registeredUser.studentCode },
          { gmail: registeredUser.gmail },
        ],
      }).toArray();

      const userAlreadyRegistered = (
        similarUsers && similarUsers.length > 0
      );
      const isSameUser = (
        similarUsers && similarUsers.length === 1 && registeredUser.equivalentTo(similarUsers[0])
      );

      if (!userAlreadyRegistered) {
        const alreadyHasRole = newGuildMember.roles.cache.has(process.env.VERIFIED_ROLE_ID!);
        if (alreadyHasRole) {
          webhookMessage.react('🤔');
          return;
        }
        const verificationError = await verifyNewGuildMember(newGuildMember);
        if (verificationError) {
          // Send error feedback to the channel
          webhookMessage.react('❌');
          webhookMessage.reply(verificationError);
          return;
        }

        // Send welcome message
        const { WELCOME_CHANNEL_ID } = process.env;
        const welcomeChannel = webhookMessage.guild?.channels.cache.get(WELCOME_CHANNEL_ID!);

        if (welcomeChannel && welcomeChannel.isTextBased()) {
          const welcomeMessage = await welcomeChannel.send({
            embeds: [
              new EmbedBuilder()
                .setDescription(
                  `<@${newGuildMember.id}> ha superado todas nuestras pruebas y ha aparecido en el servidor!!`,
                )
                .setAuthor({
                  name: 'Nuevo miembro!!! 🎉',
                  iconURL: 'https://media.discordapp.net/attachments/744860318743920711/962177397262811136/9619_GhostWave.gif',
                })
                .setThumbnail(newGuildMember.user.displayAvatarURL())
                .setColor('Blue'),
            ],
          });
          welcomeMessage.react('👋');
        }
        else {
          // TODO: Log warning: welcome channel not found
        }

        // Save user to db
        try {
          await collections.registrations?.insertOne(registeredUser);
          webhookMessage.react('👌');
        }
        catch (_error) {
          const mongoError = _error as MongoServerError;
          // Mongo fails, but we have fetched the user
          // TODO: notify mods
          webhookMessage.reply(`User registered, but could not be saved to DB: ${mongoError.errmsg}. No DM sent.`);
          webhookMessage.react('❌');
          webhookMessage.react('⚠️');
        }
      }
      else if (isSameUser) {
        // User was already registered in the database
        // Also note that the user is already in the guild

        // To check if he is verified
        const alreadyHasRole = newGuildMember.roles.cache.has(process.env.VERIFIED_ROLE_ID!);
        if (alreadyHasRole) {
          webhookMessage.react('🤔');
          return;
        }

        const verificationError = await verifyNewGuildMember(newGuildMember);
        if (verificationError) {
          // Send error feedback to the channel
          webhookMessage.react('❌');
          webhookMessage.reply(verificationError);
          return;
        }

        // Send welcome back message
        const { WELCOME_CHANNEL_ID } = process.env;
        const welcomeChannel = webhookMessage.guild?.channels.cache.get(WELCOME_CHANNEL_ID!);

        if (welcomeChannel && welcomeChannel.isTextBased()) {
          const welcomeMessage = await welcomeChannel.send({
            embeds: [
              new EmbedBuilder()
                .setDescription(
                  `<@${newGuildMember.id}> ha regresado al servidor!!`,
                )
                .setAuthor({
                  name: `${newGuildMember.user.username}... ha... vuelto...`,
                  iconURL: 'https://static.wikia.nocookie.net/floppapedia-revamped/images/6/64/RREFCC.jpg/revision/latest?cb=20210705233223',
                })
                .setThumbnail(newGuildMember.user.displayAvatarURL())
                .setColor('Blue'),
            ],
          });
          welcomeMessage.react('👋');
        }
        webhookMessage.react('👌');
        webhookMessage.react('👋');
      }
      // TODO: Option to update the user data in the database
      else {
        const reportEmbeds: EmbedBuilder[] = [];

        console.log('similarUsers:', similarUsers);

        similarUsers.forEach((similarUser) => {
          reportEmbeds.push(getReportEmbed(registeredUser, similarUser));
        });

        webhookMessage.react('🚨');
        webhookMessage.reply({
          content: reportEmbeds.length > 1
            ? `❗️ He encontrado ${reportEmbeds.length} registros similares a ese`
            : '❗️ He encontrado un registro similar a ese',
          embeds: reportEmbeds,
        });
      }
    }
  },
};

function getReportEmbed(registeredUser: RegisteredMember, similarUser: RegisteredMember) {
  let reportReason: string | undefined;
  const sameGmail = similarUser.gmail === registeredUser.gmail;
  const sameDiscordId = similarUser.discordId === registeredUser.discordId;
  const sameStudentCode = similarUser.studentCode === registeredUser.studentCode;

  const multiAccout = (sameGmail && !sameDiscordId && sameStudentCode);
  const multiAccoutImpersonation = (sameGmail && !sameDiscordId && !sameStudentCode);
  const alreadyRegImpersonation = (sameGmail && sameDiscordId && !sameStudentCode);
  const impersonation = (!sameGmail && !sameDiscordId && sameStudentCode);

  if (multiAccout) {
    reportReason = '👥 Posible multicuenta de este usuario 👥';
  }
  else if (multiAccoutImpersonation) {
    reportReason = '⚠️ Correo ya registrado, posible suplantación con multicuentas ⚠️';
  }
  else if (alreadyRegImpersonation) {
    reportReason = '⚠️ Cuenta ya registrada intentando cambiar de código ⚠️';
  }
  else if (impersonation) {
    reportReason = '⚠️ Código de estudiante ya registrado, posible suplantación ⚠️';
  }

  const timestamp = similarUser._id?.getTimestamp();
  const discordTimeAgo = `<t:${timestamp?.valueOf() as number / 1000}:R>`;
  const stringDate = timestamp?.toLocaleString('es-ES', { timeZone: 'America/Lima' });
  return (
    new EmbedBuilder()
      .setDescription(
        `**fullName**: \`${similarUser.fullname}\`\n`
        + `**gmail**: \`${similarUser.gmail}${sameGmail ? ' 🚩' : ''}\`\n`
        + `**studentCode**: \`${similarUser.studentCode}${sameStudentCode ? ' 🚩' : ''}\`\n`
        + `**base**: \`${similarUser.base}\`\n`
        + `**discordId**: \`${similarUser.discordId}${sameDiscordId ? ' 🚩' : ''}\`\n\n`
        + `_Registrado_ ${discordTimeAgo} _(${stringDate})_`,
      )
      .setFooter({ text: reportReason || ' ' })
  );
}

async function verifyNewGuildMember(newGuildMember: GuildMember): Promise<string | void> {
  const { VERIFIED_ROLE_ID } = process.env;

  // Give the user the verified role
  // Possible errors:
  // 1. Missing Permissions: https://stackoverflow.com/q/62360928
  // 2. Role not found
  try {
    await newGuildMember.roles.add(VERIFIED_ROLE_ID!);
  }
  catch (_error) {
    const apiError = _error as DiscordAPIError;
    let errorMessage = `API error when registering: ${apiError}`;
    // Send error feedback to the user
    // Send error feedback to the user
    const cantDMError = sendDMToUser(
      newGuildMember,
      'El equipo de FisiBot ha sufrido un problema (nuestro) al registrarte.\n\n'
      + 'Estamos (_claramente_) solucionando el problema, pero mientras tanto, '
      + 'puedes contactar a un administrador para que te registre manualmente.',
    );
    errorMessage += cantDMError
      ? `. Could not send DM to \`${newGuildMember.id}\``
      : `. DM feedback webhookMessage sent to \`${newGuildMember?.user.tag}\``;

    return errorMessage;
  }
  return undefined;
}

export default MessageCreateHandler;
