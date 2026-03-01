import { SlashCommandBuilder, REST, Routes } from "discord.js";
import { logger } from "./log.js";

export const askCommand = new SlashCommandBuilder()
  .setName("ask")
  .setDescription(
    "Deep research on the wiki using Claude Code (slower but more thorough than @mention)"
  )
  .addStringOption((option) =>
    option
      .setName("question")
      .setDescription("What do you want to research?")
      .setRequired(true)
      .setMaxLength(1000)
  );

export async function registerCommands(
  clientId: string,
  token: string
): Promise<void> {
  const rest = new REST().setToken(token);

  try {
    logger.info("Registering slash commands...");
    await rest.put(Routes.applicationCommands(clientId), {
      body: [askCommand.toJSON()],
    });
    logger.info("Slash commands registered successfully");
  } catch (error) {
    logger.error({ err: error }, "Failed to register slash commands");
  }
}
