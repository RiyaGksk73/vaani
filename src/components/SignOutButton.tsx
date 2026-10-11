import { signOut } from "@/app/auth/actions";

export function SignOutButton() {
  return (
    <form action={signOut}>
      <button type="submit" className="btn-sm">
        Sign out
      </button>
    </form>
  );
}
