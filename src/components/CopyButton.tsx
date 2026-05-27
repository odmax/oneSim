'use client'

interface CopyButtonProps {
  text: string
  label: string
}

export default function CopyButton({ text, label }: CopyButtonProps) {
  const handleCopy = () => {
    navigator.clipboard.writeText(text)
  }

  return (
    <button
      onClick={handleCopy}
      className="text-xs text-cyan-600 hover:text-cyan-900"
    >
      {label}
    </button>
  )
}
