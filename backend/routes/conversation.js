import express from "express";
import dotenv from "dotenv";
dotenv.config();
import OpenAIService from "../services/llm/openai.js";
import BlockchainService from "../services/blockchain/index.js";
import DatabaseService from "../services/db/index.js";
import validatePrompt from "../hooks/validatePrompt.js";
import getSolPriceInUSDT from "../hooks/solPrice.js";
import {
  shouldBeConcluded,
  concludeTournament,
} from "../hooks/concludeTournament.js";
import { solanaAuth } from "../middleware/solanaAuth.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

const router = express.Router();
const RPC_ENV = process.env.NODE_ENV === "development" ? "mainnet" : "mainnet";
const solanaRpc = `https://${RPC_ENV}.helius-rpc.com/?api-key=${process.env.RPC_KEY}`;

router.post("/submit/:id", solanaAuth, async (req, res) => {
  try {
    let { prompt, signature, walletAddress, transactionId } = req.body;
    const { id } = req.params;

    if (!prompt || !signature || !walletAddress || !transactionId) {
      return res.write("Missing required fields");
    }

    if (walletAddress !== req.user.walletAddress) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    const challenge = await DatabaseService.getChallengeById(id);
    if (!challenge) return res.write("Challenge not found");

    const transaction = await DatabaseService.getTransactionById(transactionId);
    if (!transaction) return res.write("Transaction not found");

    const fee_multiplier = challenge.fee_multiplier || 100;
    const programId = challenge.idl?.address;

    const tournamentPDA = challenge.tournamentPDA;

    if (!programId || !tournamentPDA)
      return res.write("Program ID or Tournament PDA not found");

    const challengeName = challenge.name;
    const contextLimit = challenge.contextLimit;

    prompt = await validatePrompt(prompt, challenge);

    if (challenge.status === "upcoming") {
      return res.write(`Tournament starts in ${challenge.start_date}`);
    } else if (challenge.status === "concluded") {
      return res.write("Tournament has already concluded");
    } else if (challenge.status != "active") {
      return res.write("Tournament is not active");
    }

    const blockchainService = new BlockchainService(solanaRpc, programId);
    const currentExpiry = challenge.expiry;
    const now = new Date();
    const oneHourInMillis = 3600000;
    const model = challenge["model"];

    let tournamentData, feeType, feeMulPct, winnerPayoutPct;
    let entryFee = challenge.entryFee;
    let sol_prize = challenge.winning_prize;
    let isValidTransaction;

    if (challenge.type != "transfer") {
      tournamentData = await blockchainService.getTournamentData(tournamentPDA);

      entryFee = tournamentData.entryFee;
      feeMulPct = tournamentData.feeMulPct;
      winnerPayoutPct = tournamentData.winnerPayoutPct;
      feeType = tournamentData.feeType;
      sol_prize = tournamentData.programBalance;

      isValidTransaction = await blockchainService.verifyTransactionSignature(
        signature,
        transaction,
        entryFee,
        feeMulPct,
        winnerPayoutPct,
        feeType,
        walletAddress
      );
    } else {
      const { isValid } = await blockchainService.verifyBountyTransaction(
        signature,
        challenge.tournamentPDA,
        walletAddress,
        challenge.entryFee
      );

      isValidTransaction = isValid;
      const accountBalance = await blockchainService.getAccountBalance(
        challenge.tournamentPDA
      );
      sol_prize = accountBalance / LAMPORTS_PER_SOL;
    }

    console.log("isValidTransaction:", isValidTransaction);

    if (!isValidTransaction) {
      return res.write("INVALID TRANSACTION");
    }

    const solPrice = await getSolPriceInUSDT();
    const usd_prize = sol_prize * solPrice;

    const lastTransaction = await DatabaseService.getLastTransaction(
      challengeName
    );

    if (transaction.entryFee < lastTransaction.entryFee) {
      return res.write("INVALID TRANSACTION");
    }

    const duplicateTxn = await DatabaseService.findOneChat({
      txn: signature,
    });

    if (duplicateTxn) {
      return res.write("DUPLICATE TRANSACTION");
    }

    await DatabaseService.updateChallenge(
      id,
      {
        entryFee: entryFee,
        usd_prize: usd_prize,
        winning_prize: sol_prize,
        ...(currentExpiry - now < oneHourInMillis && {
          expiry: new Date(now.getTime() + oneHourInMillis),
        }),
      },
      true
    );

    let thread;
    let isInitialThread = true;
    if (challenge.framework) {
      thread = challenge.framework;
    } else if (contextLimit > 1) {
      const chatHistory = await DatabaseService.getChatHistory(
        {
          challenge: challengeName,
          address: walletAddress,
        },
        {
          _id: 0,
          role: 1,
          content: 1,
          thread_id: 1,
        },
        { date: -1 },
        contextLimit
      );

      if (chatHistory.length > 0) {
        const threadCounts = {};
        chatHistory.forEach((chat) => {
          threadCounts[chat.thread_id] =
            (threadCounts[chat.thread_id] || 0) + 1;
        });

        let existingThread = null;
        for (const [threadId, count] of Object.entries(threadCounts)) {
          if (count < contextLimit) {
            existingThread = threadId;
            break;
          }
        }

        if (existingThread) {
          isInitialThread = false;
          console.log("found existing thread");
          thread = await OpenAIService.getThread(existingThread);
        } else {
          console.log("all threads are full, creating new thread");
          thread = await OpenAIService.createThread();
        }
      } else {
        console.log("created initial thread");
        thread = await OpenAIService.createThread();
      }
    } else {
      thread = await OpenAIService.createThread();
    }

    const userMessage = {
      challenge: challengeName,
      model: model,
      role: "user",
      content: prompt,
      address: walletAddress,
      txn: signature,
      fee: entryFee,
      date: now,
      thread_id: thread.id,
    };

    const assistantMessage = {
      challenge: challengeName,
      model: model,
      role: "assistant",
      content: "",
      tool_calls: {},
      address: walletAddress,
      thread_id: thread.id,
      date: new Date(),
    };

    if (challenge.suffix && isInitialThread) {
      const suffix = JSON.stringify(transaction[challenge.suffix]);
      prompt += `\n${suffix}`;
    }

    const health = challenge.health;

    prompt += `\n\nCurrent Agent Health: ${health}`;

    await DatabaseService.createChat(userMessage);
    await DatabaseService.updateTransactionStatus(transactionId, "confirmed");

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Access-Control-Allow-Origin", "*");

    await OpenAIService.addMessageToThread(thread.id, prompt);

    const run = await OpenAIService.createRun(
      thread.id,
      challenge.assistant_id,
      challenge.tool_choice
    );

    for await (const chunk of run) {
      const event = chunk.event;
      if (event === "thread.message.delta") {
        const delta = chunk.data.delta.content[0].text.value;
        assistantMessage.content += delta;
        res.write(delta);
      } else if (event === "thread.message.completed") {
        if (challenge.type === "phrases" && challenge.phrases?.length > 0) {
          const allPhrasesIncluded = challenge.phrases.every((phrase) =>
            assistantMessage.content
              .toLowerCase()
              .includes(phrase.toLowerCase())
          );

          if (allPhrasesIncluded) {
            const successMessage = await concludeTournament(
              isValidTransaction,
              challenge,
              assistantMessage,
              userMessage,
              blockchainService,
              DatabaseService,
              tournamentPDA,
              walletAddress,
              signature
            );
            assistantMessage.content = successMessage;
          } else {
            await DatabaseService.createChat(assistantMessage);
          }
        } else {
          await DatabaseService.createChat(assistantMessage);
        }
      } else if (event === "thread.run.requires_action") {
        const required_action = chunk.data.required_action;
        const toolCalls = required_action.submit_tool_outputs.tool_calls[0];
        const functionName = toolCalls.function.name;
        const functionArguments = toolCalls.function.arguments;
        const jsonArgs = JSON.parse(functionArguments);
        const functionParams = challenge.tools.find(
          (tool) => tool.name === functionName
        )?.parameters?.properties;

        let results = jsonArgs.message;
        let hp =
          functionName === "reduceHP"
            ? health - jsonArgs.amount
            : functionName === "addHP"
            ? Math.min(100, health + jsonArgs.amount)
            : health;

        await DatabaseService.updateChallenge(id, { health: hp });

        // const functionParamsKeys = Object.keys(functionParams);
        // let results = functionParamsKeys
        //   .map((key) => {
        //     if (key === "results") {
        //       return jsonArgs[key];
        //     } else {
        //       const resultString =
        //         jsonArgs[key] !== undefined
        //           ? `**${key
        //               .split("_")
        //               .map(
        //                 (word) => word.charAt(0).toUpperCase() + word.slice(1)
        //               )
        //               .join(" ")}**: ${jsonArgs[key]}`
        //           : null;
        //       return resultString?.replace("Response: ", "");
        //     }
        //   })
        //   .filter(Boolean)
        //   .join("\n");

        // if (challenge.tools_description) {
        //   results = `### 🚨 Function Called:\n${results}`;
        // } else {
        //   results = `### 🚨 Function Called: ${functionName}\n${results}`;
        // }

        if (required_action.type === "submit_tool_outputs") {
          const tool_outputs = [
            {
              tool_call_id: toolCalls.id,
              output: "success",
            },
          ];
          await OpenAIService.submitRun(thread.id, chunk.data.id, tool_outputs);
        }

        assistantMessage.tool_calls = {
          results: results,
          function_name: functionName,
        };
        assistantMessage.content += results;

        // const toBeConcluded = shouldBeConcluded(
        //   challenge,
        //   functionName,
        //   jsonArgs
        // );

        const toBeConcluded = hp <= 0;

        if (toBeConcluded) {
          const successMessage = await concludeTournament(
            isValidTransaction,
            challenge,
            assistantMessage,
            userMessage,
            blockchainService,
            DatabaseService,
            tournamentPDA,
            walletAddress,
            signature
          );
          res.write(successMessage);
        } else {
          await DatabaseService.createChat(assistantMessage);
          res.write(assistantMessage.content);
        }
      }
    }
    res.end();
  } catch (error) {
    console.error("Error handling submit:", error);
    return res.write(error?.error?.message || "Server error");
  }
});

router.get("/breakers/:address", async (req, res) => {
  try {
    const { address } = req.params;
    const result = await DatabaseService.getBreaker(address);
    const chatCount = await DatabaseService.getChatCount({
      address: address,
      role: "user",
    });
    const challenges = await DatabaseService.getSettings();

    let activeChallenge = challenges.find(
      (challenge) => challenge.status === "active"
    );

    if (!activeChallenge) {
      const upcomingChallenge = challenges.find(
        (challenge) => challenge.status === "upcoming"
      );
      if (upcomingChallenge) {
        activeChallenge = upcomingChallenge;
      } else {
        activeChallenge = challenges.sort(
          (a, b) => a.start_date - b.start_date
        )[0];
      }
    }

    return res.json({ ...result, chatCount, activeChallenge });
  } catch (error) {
    console.error("Error fetching user conversations:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export { router as conversationRoute };
