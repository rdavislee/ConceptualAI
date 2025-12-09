import { apiRequest } from "../utils/api.ts";
import { saveTokens } from "../utils/config.ts";

interface LoginResponse {
  user: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Prompt for password input (hidden)
 * Uses Deno.stdin.setRaw to disable echo
 */
async function promptPassword(promptText: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Write prompt
  await Deno.stdout.write(encoder.encode(promptText));

  try {
    // Enable raw mode to disable echo
    Deno.stdin.setRaw(true, { cbreak: true });

    let password = "";
    const buffer = new Uint8Array(1);

    // Read password character by character
    while (true) {
      const n = await Deno.stdin.read(buffer);
      if (n === null || n === 0) break;

      const char = buffer[0];

      // Enter key (13 = CR, 10 = LF)
      if (char === 13 || char === 10) {
        break;
      }

      // Ctrl+C (3)
      if (char === 3) {
        Deno.stdin.setRaw(false);
        console.log("\n");
        Deno.exit(1);
      }

      // Backspace/DEL (127 = DEL, 8 = BS)
      if (char === 127 || char === 8) {
        if (password.length > 0) {
          password = password.slice(0, -1);
          // Move cursor back, erase character, move cursor back again
          await Deno.stdout.write(encoder.encode("\b \b"));
        }
      } else if (char >= 32 && char <= 126) {
        // Printable ASCII characters
        password += decoder.decode(buffer.slice(0, n));
        // Show asterisk instead of actual character
        await Deno.stdout.write(encoder.encode("*"));
      }
    }

    // Disable raw mode
    Deno.stdin.setRaw(false);

    // New line after password input
    await Deno.stdout.write(encoder.encode("\n"));

    return password;
  } catch (error) {
    // Fallback if raw mode is not supported
    try {
      Deno.stdin.setRaw(false);
    } catch {
      // Ignore errors when disabling raw mode
    }
    console.warn(
      "Warning: Could not hide password input. Password will be visible.",
    );
    const password = prompt(promptText);
    return password || "";
  }
}

export async function login() {
  try {
    // Prompt for email
    const email = prompt("Email: ");
    if (!email || email.trim() === "") {
      console.error("Error: Email is required");
      Deno.exit(1);
    }

    // Prompt for password (hidden)
    const password = await promptPassword("Password: ");
    if (!password || password.trim() === "") {
      console.error("Error: Password is required");
      Deno.exit(1);
    }

    // Call login API endpoint
    const response = await apiRequest<LoginResponse>(
      "/api/auth/login",
      {
        email: email.trim(),
        password: password,
      },
      {
        requireAuth: false, // Login doesn't require authentication
      },
    );

    // Save tokens to config
    await saveTokens(response.accessToken, response.refreshToken);

    console.log("✓ Successfully logged in");
    console.log(`  User ID: ${response.user}`);
  } catch (error) {
    if (error instanceof Error) {
      // Handle specific error messages from API
      if (error.message.includes("Invalid email or password")) {
        console.error("Error: Invalid email or password");
      } else {
        console.error(`Error: ${error.message}`);
      }
    } else {
      console.error(`Error: ${String(error)}`);
    }
    Deno.exit(1);
  }
}
