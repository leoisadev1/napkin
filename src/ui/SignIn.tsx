// Sign-in slot. The widget talks to /api/chatgpt; if the API is down it must not take the app with it.
import { Component } from "react";
import type { ReactNode } from "react";
import { LoginWithChatGPT } from "@opencoredev/loginwithchatgpt-react";
import { useMediaQuery } from "./useMediaQuery";

class Contain extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function SignIn() {
  const narrow = useMediaQuery("(max-width: 730px)");
  return (
    <Contain>
      <div className="signin">
        <LoginWithChatGPT label={narrow ? "Sign in" : "Sign in with ChatGPT"} consent={{ appName: "Whiteboard" }} />
      </div>
    </Contain>
  );
}
