import Link from "next/link";

/** Placeholder for sections that are in the navigation but not built yet. */
export function ComingSoon({ title, blurb }: { title: string; blurb: string }) {
  return (
    <>
      <div className="dash-head">
        <h1>{title}</h1>
      </div>
      <div className="table-card empty-state">
        <h2>Not available yet</h2>
        <p className="small">{blurb}</p>
        <p className="small">
          <Link href="/">Back to Translate</Link>
        </p>
      </div>
    </>
  );
}
