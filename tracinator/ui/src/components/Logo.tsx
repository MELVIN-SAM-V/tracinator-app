import { Zap } from 'lucide-react'

interface Props {
  size?: number
  textClassName?: string
}

export default function Logo({ size = 16, textClassName = 'text-sm' }: Props) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <Zap size={size} className="text-indigo-400" />
      <span className={`font-bold bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent ${textClassName}`}>
        Tracinator
      </span>
    </div>
  )
}
