type Props = {
  text: string;
  className?: string;
};

export function StreamingText({ text, className }: Props) {
  return (
    <div className={`whitespace-pre-wrap ${className ?? ''}`}>
      {text}
      <span className="animate-pulse">|</span>
    </div>
  );
}
